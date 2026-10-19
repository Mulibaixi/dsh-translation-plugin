import { parseNormalTranslationTarget, type NormalTranslationUnitTarget } from './normal-translation.js'
import { parseFileJobRequest, type FileJobList, type FileJobReadReview, type FileJobRevision, type FileJobRestart, type FileJobReviewPage, type FileJobSummary } from './file-jobs.js'

/** Metadata only: a durable unit identity never grants a replay of an old material delivery. */
export interface FileHistoryUnit {
  readonly target: NormalTranslationUnitTarget
  readonly jobId: string | null
  readonly name: string
  readonly sourceTotalCodePoints: number
  readonly targetLanguage: string
  readonly instruction: string
  readonly organizedRequirements: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly phase: string
  readonly unsettled: boolean
  readonly summaryVersion: number | null
  readonly resultVersion: number | null
  readonly resultRevisionId: string | null
}
export interface FileRetranslation { readonly target: NormalTranslationUnitTarget; readonly operationId: string; readonly organizedRequirements: string }
export type FileHistoryRequest =
  | { readonly action: 'list'; readonly request: FileJobList }
  | { readonly action: 'read'; readonly request: FileJobReadReview }
  | { readonly action: 'revise'; readonly request: FileJobRevision }
  | { readonly action: 'unit'; readonly target: NormalTranslationUnitTarget }
  | { readonly action: 'source'; readonly target: NormalTranslationUnitTarget; readonly range: { readonly start: number; readonly end: number } }
  | ({ readonly action: 'restart' } & FileRetranslation)
export type FileHistoryValue =
  | { readonly action: 'list'; readonly items: readonly FileHistoryUnit[]; readonly nextOffset: number | null }
  | { readonly action: 'read'; readonly page: FileJobReviewPage }
  | { readonly action: 'revise'; readonly summary: FileJobSummary }
  | { readonly action: 'unit'; readonly unit: FileHistoryUnit }
  | { readonly action: 'source'; readonly target: NormalTranslationUnitTarget; readonly range: { readonly start: number; readonly end: number }; readonly text: string; readonly totalCodePoints: number }
  | { readonly action: 'restart'; readonly restart?: FileJobRestart; readonly existing?: FileJobSummary }
function object(raw: unknown): asserts raw is Record<string, unknown> { if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('Invalid file history object') }
function exact(raw: Record<string, unknown>, fields: readonly string[]): void { if (Object.keys(raw).length !== fields.length || fields.some(field => !Object.hasOwn(raw, field))) throw new TypeError('Unexpected file history fields') }
export function parseFileRetranslation(raw: unknown): FileRetranslation {
  object(raw)
  exact(raw, ['target', 'operationId', 'organizedRequirements'])
  const target = parseNormalTranslationTarget(raw.target)
  if (target.kind !== 'unit' || typeof raw.operationId !== 'string' || !raw.operationId.trim() || raw.operationId.length > 3000 ||
    typeof raw.organizedRequirements !== 'string' || raw.organizedRequirements.length > 4000) throw new TypeError('Retranslation requires an exact unit, operationId and organizedRequirements')
  return { target, operationId: raw.operationId, organizedRequirements: raw.organizedRequirements }
}
export function parseFileHistoryRequest(raw: unknown): FileHistoryRequest {
  object(raw)
  if (raw.action === 'unit' || raw.action === 'source') {
    exact(raw, raw.action === 'unit' ? ['action', 'target'] : ['action', 'target', 'range'])
    const target = parseNormalTranslationTarget(raw.target)
    if (target.kind !== 'unit') throw new TypeError('Expected file unit')
    if (raw.action === 'source') {
      object(raw.range)
      exact(raw.range, ['start', 'end'])
      if (!Number.isSafeInteger(raw.range.start) || !Number.isSafeInteger(raw.range.end) || (raw.range.start as number) < 0 || (raw.range.end as number) <= (raw.range.start as number) || (raw.range.end as number) - (raw.range.start as number) > 4000) throw new TypeError('Invalid source range')
      return { action: 'source', target, range: { start: raw.range.start as number, end: raw.range.end as number } }
    }
    return { action: 'unit', target }
  }
  if (raw.action === 'restart') { const { action: _action, ...request } = raw; return { action: 'restart', ...parseFileRetranslation(request) } }
  exact(raw, ['action', 'request'])
  const methods = { list: 'list', read: 'readReview', revise: 'revise' } as const
  if (!(raw.action as string in methods)) throw new TypeError('Unknown file history action')
  return { action: raw.action, request: parseFileJobRequest(methods[raw.action as keyof typeof methods], raw.request) } as FileHistoryRequest
}
export function parseFileHistoryUnit(raw: unknown): FileHistoryUnit {
  object(raw)
  exact(raw, ['target', 'jobId', 'name', 'sourceTotalCodePoints', 'targetLanguage', 'instruction', 'organizedRequirements', 'createdAt', 'updatedAt', 'phase', 'unsettled', 'summaryVersion', 'resultVersion', 'resultRevisionId'])
  const target = parseNormalTranslationTarget(raw.target)
  if (target.kind !== 'unit' || typeof raw.name !== 'string' || typeof raw.phase !== 'string' || typeof raw.unsettled !== 'boolean' ||
    typeof raw.targetLanguage !== 'string' || typeof raw.instruction !== 'string' || typeof raw.createdAt !== 'string' || typeof raw.updatedAt !== 'string' ||
    raw.organizedRequirements !== null && typeof raw.organizedRequirements !== 'string' || !Number.isSafeInteger(raw.sourceTotalCodePoints) || (raw.sourceTotalCodePoints as number) < 0 ||
    raw.jobId !== null && typeof raw.jobId !== 'string' || raw.resultRevisionId !== null && typeof raw.resultRevisionId !== 'string' ||
    [raw.summaryVersion, raw.resultVersion].some(value => value !== null && (!Number.isSafeInteger(value) || (value as number) < 1))) throw new TypeError('Invalid file history metadata')
  return structuredClone({ ...raw, target }) as unknown as FileHistoryUnit
}
export function parseFileHistoryValue(raw: unknown): FileHistoryValue {
  object(raw)
  if (new TextEncoder().encode(JSON.stringify(raw)).byteLength > 32768) throw new TypeError('File history page exceeds transport budget')
  switch (raw.action) {
    case 'list':
      if (!Array.isArray(raw.items) || raw.items.length > 20 || raw.nextOffset !== null && (!Number.isSafeInteger(raw.nextOffset) || (raw.nextOffset as number) < 1)) throw new TypeError('Invalid file history page')
      return { action: 'list', items: raw.items.map(parseFileHistoryUnit), nextOffset: raw.nextOffset as number | null }
    case 'unit': return { action: 'unit', unit: parseFileHistoryUnit(raw.unit) }
    case 'source': {
      exact(raw, ['action', 'target', 'range', 'text', 'totalCodePoints'])
      const request = parseFileHistoryRequest({ action: raw.action, target: raw.target, range: raw.range })
      if (request.action !== 'source' || typeof raw.text !== 'string' || Array.from(raw.text).length !== request.range.end - request.range.start || !Number.isSafeInteger(raw.totalCodePoints) || (raw.totalCodePoints as number) < request.range.end) throw new TypeError('Invalid source page')
      return { ...request, text: raw.text, totalCodePoints: raw.totalCodePoints as number }
    }
    case 'restart':
      if (Boolean(raw.restart) === Boolean(raw.existing)) throw new TypeError('Expected one restart or recorded outcome')
      return { action: 'restart', ...(raw.restart ? { restart: parseFileJobRequest('restart', raw.restart) as FileJobRestart } : {}), ...(raw.existing ? { existing: structuredClone(raw.existing) as FileJobSummary } : {}) }
    case 'read': object(raw.page); object(raw.page.summary); if (typeof raw.page.summary.jobId !== 'string') throw new TypeError('Invalid saved page'); break
    case 'revise': object(raw.summary); if (typeof raw.summary.jobId !== 'string') throw new TypeError('Invalid saved revision'); break
    default: throw new TypeError('Unknown file history reply')
  }
  return structuredClone(raw) as unknown as FileHistoryValue
}
