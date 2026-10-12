import { parseNormalTranslationTarget, type NormalTranslationMaterialTarget } from './normal-translation.js'
import { parseTranslationSourceScope, type TranslationSourceScope } from './translation-sources.js'
import { sourceCodePointLength, type TranslationSourceRange } from './translation-source-read.js'
import type { TranslationMaterialRoute } from './translation-material.js'

export const MAX_ANALYSIS_CALLS = 512
export const MAX_ANALYSIS_RANGES = 256
export const MAX_ANALYSIS_PAGE_ITEMS = 50
export const MAX_ANALYSIS_PAGE_BYTES = 32768
export const MAX_ANALYSIS_CANDIDATES_PER_CALL = 100
export const TERMINOLOGY_ANALYSIS_PROMPT_VERSION = 'terminology-analysis-v1'

export type AnalysisResult<T> = { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: AnalysisError }
export interface AnalysisError { readonly code: string; readonly message: string; readonly stage: string }
export interface TranslationAnalysisStart {
  readonly target: NormalTranslationMaterialTarget
  readonly operationId: string
  readonly analysisId: string
  /** Omitted means the complete source. Supplied ranges are fixed in source order. */
  readonly ranges?: readonly TranslationSourceRange[]
  /** Explicit source positions that need no analysis, such as protected copy regions. */
  readonly excludedRanges?: readonly TranslationSourceRange[]
}
export interface TranslationAnalysisQuery {
  readonly target: NormalTranslationMaterialTarget
  readonly analysisId: string
  readonly version: 1
}
export interface TranslationAnalysisRead extends TranslationAnalysisQuery {
  readonly section: 'candidates' | 'coverage' | 'calls'
  readonly cursor?: string
  readonly limit?: number
}
/** Only these semantic fields come from the model. Identity and occurrences are Host facts. */
export interface AnalysisCandidateContent {
  readonly original: string
  readonly suggestedTranslation: string
  readonly description?: string
}
export interface AnalysisCandidate extends AnalysisCandidateContent {
  readonly id: string
  readonly version: 1
  readonly analysisId: string
  readonly callId: string
  readonly sourceVersion: number
  readonly occurrences: readonly TranslationSourceRange[]
  /** Bounded examples, not an exhaustive occurrence index. Count remains the exact scan-range count. */
  readonly occurrenceCount: number
  readonly occurrenceSamples: 'first_8_exact_matches'
  readonly origin: 'model_inferred'
}
export interface AnalysisCoverage {
  readonly callId: string
  readonly range: TranslationSourceRange
  readonly candidateCount: number
}
export interface AnalysisConstraint {
  readonly id: string
  readonly entryVersion: number
  readonly forms: readonly string[]
  readonly preferred: string
  readonly description: string
  readonly userFixed: boolean
}
export interface AnalysisCall {
  readonly callId: string
  readonly range: TranslationSourceRange
  readonly route: TranslationMaterialRoute
  readonly promptVersion: typeof TERMINOLOGY_ANALYSIS_PROMPT_VERSION
  readonly outputProtocol: 'restricted_json'
  readonly contextRanges: readonly TranslationSourceRange[]
  readonly status: 'running' | 'completed' | 'failed' | 'unknown'
  readonly dispatchedAt: string
  readonly finishedAt: string | null
  readonly inputEstimate: { readonly tokens: number; readonly kind: 'estimated'; readonly contextWindow: number | null; readonly maxOutputTokens: number | null }
  readonly constraintRefs: readonly { readonly id: string; readonly entryVersion: number }[]
  readonly usage: { readonly inputTokens: number | null; readonly outputTokens: number | null }
  readonly error: AnalysisError | null
}
/** A short runtime fact. No source body, candidate table, or translation history is stored here. */
export interface AnalysisRun {
  readonly analysisId: string
  readonly version: 1
  readonly operationId: string
  readonly target: NormalTranslationMaterialTarget
  readonly scope: TranslationSourceScope
  readonly sourceVersion: number
  readonly route: TranslationMaterialRoute
  readonly status: 'frozen' | 'preparing' | 'running' | 'completed' | 'failed' | 'unknown'
  readonly totalCodePoints: number
  readonly requestedRanges: readonly TranslationSourceRange[]
  readonly excludedRanges: readonly TranslationSourceRange[]
  readonly coverageComplete: boolean
  readonly coverageMeaning: 'mechanical_source_scan'
  readonly completedCodePoints: number
  readonly candidateCount: number
  readonly plannedCalls: number
  readonly actualCalls: number
  readonly error: AnalysisError | null
  readonly notification: AnalysisNotification
  readonly storage: 'runtime_only'
  readonly createdAt: string
  readonly updatedAt: string
}
export interface AnalysisNotification {
  readonly state: 'pending' | 'enqueued' | 'claimed' | 'discarded' | 'unavailable'
  readonly reason: string | null
}
export type AnalysisReceipt = AnalysisRun
export interface AnalysisPage extends TranslationAnalysisQuery {
  readonly section: TranslationAnalysisRead['section']
  readonly items: readonly (AnalysisCandidate | AnalysisCoverage | AnalysisCall)[]
  readonly nextCursor: string | null
}
export interface AnalysisPhaseReference {
  readonly scope: TranslationSourceScope
  readonly analysisId: string
  readonly operationId: string
  readonly version: 1
  readonly sourceVersion: number
}

function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key)) ||
    Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new TypeError('Unexpected analysis fields')
}
function text(value: unknown, max: number, empty = false): asserts value is string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || sourceCodePointLength(value) > max) throw new TypeError('Invalid analysis text')
}
function range(value: unknown): TranslationSourceRange {
  exact(value, ['start', 'end'])
  if (!Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.end) || (value.start as number) < 0 || (value.end as number) <= (value.start as number)) throw new TypeError('Invalid analysis source range')
  return { start: value.start as number, end: value.end as number }
}
function ranges(value: unknown): readonly TranslationSourceRange[] {
  if (!Array.isArray(value) || value.length > MAX_ANALYSIS_RANGES) throw new TypeError('Analysis ranges exceed limit')
  const result = value.map(range)
  if (result.some((item, index) => index > 0 && item.start < result[index - 1]!.end)) throw new TypeError('Analysis ranges must be ordered and nonoverlapping')
  return result
}
function target(value: unknown): NormalTranslationMaterialTarget {
  const parsed = parseNormalTranslationTarget(value)
  if (parsed.kind !== 'material') throw new TypeError('Analysis requires an exact delivered material')
  return parsed
}
export function parseTranslationAnalysisStart(value: unknown): TranslationAnalysisStart {
  exact(value, ['target', 'operationId', 'analysisId'], ['ranges', 'excludedRanges'])
  text(value.operationId, 2048); text(value.analysisId, 2048)
  return { target: target(value.target), operationId: value.operationId, analysisId: value.analysisId,
    ...(value.ranges === undefined ? {} : { ranges: ranges(value.ranges) }),
    ...(value.excludedRanges === undefined ? {} : { excludedRanges: ranges(value.excludedRanges) }) }
}
export function parseTranslationAnalysisQuery(value: unknown): TranslationAnalysisQuery {
  exact(value, ['target', 'analysisId', 'version'])
  text(value.analysisId, 2048)
  if (value.version !== 1) throw new TypeError('Invalid analysis version')
  return { target: target(value.target), analysisId: value.analysisId, version: 1 }
}
export function parseTranslationAnalysisRead(value: unknown): TranslationAnalysisRead {
  exact(value, ['target', 'analysisId', 'version', 'section'], ['cursor', 'limit'])
  const query = parseTranslationAnalysisQuery({ target: value.target, analysisId: value.analysisId, version: value.version })
  if (!['candidates', 'coverage', 'calls'].includes(String(value.section))) throw new TypeError('Invalid analysis section')
  if (value.cursor !== undefined) text(value.cursor, 300)
  if (value.limit !== undefined && (!Number.isSafeInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > MAX_ANALYSIS_PAGE_ITEMS)) throw new TypeError('Invalid analysis page limit')
  return { ...query, section: value.section as TranslationAnalysisRead['section'],
    ...(value.cursor === undefined ? {} : { cursor: value.cursor }), ...(value.limit === undefined ? {} : { limit: value.limit as number }) }
}
export function parseAnalysisCandidateOutput(textOutput: string): readonly AnalysisCandidateContent[] {
  if (new TextEncoder().encode(textOutput).byteLength > 131072) throw new TypeError('Analysis output exceeds JSON budget')
  const value: unknown = JSON.parse(textOutput)
  exact(value, ['candidates'])
  if (!Array.isArray(value.candidates) || value.candidates.length > MAX_ANALYSIS_CANDIDATES_PER_CALL) throw new TypeError('Invalid analysis candidate list')
  return value.candidates.map(item => {
    exact(item, ['original', 'suggestedTranslation'], ['description'])
    text(item.original, 500); text(item.suggestedTranslation, 2000)
    if (item.description !== undefined) text(item.description, 2000, true)
    return { original: item.original, suggestedTranslation: item.suggestedTranslation, ...(item.description === undefined ? {} : { description: item.description }) }
  })
}
export function parseAnalysisPhaseReference(value: unknown): AnalysisPhaseReference {
  exact(value, ['scope', 'analysisId', 'operationId', 'version', 'sourceVersion'])
  text(value.analysisId, 2048); text(value.operationId, 2048)
  if (value.version !== 1 || !Number.isSafeInteger(value.sourceVersion) || (value.sourceVersion as number) < 1) throw new TypeError('Invalid analysis phase version')
  return { scope: parseTranslationSourceScope(value.scope), analysisId: value.analysisId, operationId: value.operationId, version: 1, sourceVersion: value.sourceVersion as number }
}
