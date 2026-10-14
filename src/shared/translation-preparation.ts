import { parseNormalTranslationTarget, type NormalTranslationMaterialTarget, type NormalTranslationUnitTarget, type NormalTranslationTarget } from './normal-translation.js'
import { parseTranslationSourceScope, type TranslationSourceScope } from './translation-sources.js'
import { sourceCodePointLength, type TranslationSourceRange } from './translation-source-read.js'
import type { TranslationMaterialRoute } from './translation-material.js'
import { parseTranslationMaterialEnvelope, type TranslationMaterialEnvelope } from './translation-material.js'
import { decodeTopicTermSnapshot, type TopicTermSnapshot, type TermUserAdoption, type TermEvidenceRef } from '../memory/topic-terms.js'

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

export const MAX_PREPARATION_PACKET_BYTES = 196608
export const MAX_PREPARATION_PAGE_BYTES = 32768
export const MAX_PREPARATION_PAGE_ITEMS = 50
export interface PreparationCandidateRef { readonly kind: 'candidate'; readonly id: string; readonly version: 1 }
export interface PreparationTopicTermRef { readonly kind: 'topic_term'; readonly id: string; readonly entryVersion: number }
export type PreparationTermRef = PreparationCandidateRef | PreparationTopicTermRef
export interface PreparationTermSelection {
  readonly ref: PreparationTermRef
  /** Scope of this meaning; not a list of occurrence samples. */
  readonly ranges: readonly TranslationSourceRange[]
  readonly descriptionRef?: { readonly id: string; readonly version: 1 }
  /** A task-only correction, bound to the exact analyzed spelling. */
  readonly content?: { readonly original: string; readonly preferred: string; readonly description?: string }
}
export interface PreparationQuestion {
  readonly id: string
  readonly question: string
  readonly ranges: readonly TranslationSourceRange[]
  readonly decision: string | null
}
export interface PreparationReferenceRef { readonly id: string; readonly version: number; readonly range: TranslationSourceRange }
export interface TranslationPreparationPrepare {
  readonly target: NormalTranslationMaterialTarget
  readonly preparationId: string
  readonly operationId: string
  readonly analysisId: string
  readonly analysisVersion: 1
}
export interface TranslationPreparationSet {
  readonly target: NormalTranslationMaterialTarget
  readonly preparationId: string
  readonly expectedVersion: number
  readonly operationId: string
  readonly organizedRequirements: string
  readonly termSelections: readonly PreparationTermSelection[]
  /** Main model declaration, independently recorded from mechanical scanning. */
  readonly reviewedRanges: readonly TranslationSourceRange[]
  readonly backgroundRanges?: readonly TranslationSourceRange[]
  readonly referenceRefs?: readonly PreparationReferenceRef[]
  readonly questions?: readonly PreparationQuestion[]
}
export interface TranslationPreparationQuery {
  readonly target: NormalTranslationTarget
  readonly preparationId: string
  readonly version: number
}
/** Explicit main-model review of a corrected source; it does not claim a new analysis run. */
export interface TranslationPreparationCorrectionReview {
  readonly target: NormalTranslationUnitTarget
  readonly preparationId: string
  readonly expectedVersion: number
  readonly operationId: string
  readonly basis: string
  readonly organizedRequirements: string
  readonly termSelections: readonly PreparationTermSelection[]
  readonly reviewedRanges: readonly TranslationSourceRange[]
  readonly excludedRanges?: readonly TranslationSourceRange[]
  readonly backgroundRanges?: readonly TranslationSourceRange[]
  readonly questions?: readonly PreparationQuestion[]
}
/** Source matching is read by Host; scope, current source and terms are checked by Client. */
export interface PreparationCorrectionReviewFacts {
  readonly scope: TranslationSourceScope
  readonly unitId: string
  readonly sourceVersion: number
  readonly sourceSha256: string
  readonly totalCodePoints: number
  readonly correctionOperationId: string
  readonly analysisActualCalls: number | null
  readonly topicTerms: TopicTermSnapshot
  readonly termMatches: readonly { readonly ref: PreparationTermRef; readonly matched: boolean }[]
  readonly relevantFixedIds: readonly string[]
}
export interface PreparationCorrectionReview {
  readonly meaning: 'main_model_correction_review'
  readonly previousPreparationRef: { readonly id: string; readonly version: number }
  readonly correctionOperationId: string
  readonly basis: string
  /** Exact original analysis source. Its mechanical coverage remains in those coordinates. */
  readonly analysisBasis: { readonly sourceVersion: number; readonly sourceSha256: string; readonly totalCodePoints: number; readonly actualCalls: number | null }
  readonly requiredRanges: readonly TranslationSourceRange[]
  readonly excludedRanges: readonly TranslationSourceRange[]
  readonly fixedTermVersions: Readonly<Record<string, number>>
  readonly termMappings: readonly { readonly previous: PreparationTermRef; readonly current: PreparationTermRef | null }[]
  readonly complete: boolean
}
export type PreparationSection = 'summary' | 'candidates' | 'terms' | 'coverage' | 'background' | 'references' | 'questions' | 'conflicts' | 'correction_review'
export interface TranslationPreparationRead extends TranslationPreparationQuery {
  readonly section: PreparationSection
  readonly cursor?: string
  readonly limit?: number
}
/** Transported by the authorized Host, never supplied as a main-model claim. */
export interface PreparationAnalysisFacts {
  readonly run: AnalysisRun
  readonly candidates: readonly AnalysisCandidate[]
  readonly coverage: readonly AnalysisCoverage[]
}
export interface PreparationCurrentFacts {
  readonly envelope: Extract<TranslationMaterialEnvelope, { kind: 'material' }>
  readonly topicTerms: TopicTermSnapshot
}
export interface PreparationPrepareFacts extends PreparationCurrentFacts { readonly analysis: PreparationAnalysisFacts }
export interface PreparationCandidate {
  readonly id: string
  readonly version: 1
  readonly original: string
  readonly preferred: string
  readonly members: readonly { readonly id: string; readonly version: 1; readonly callId: string }[]
  readonly descriptions: readonly { readonly description: string; readonly candidateRefs: readonly { readonly id: string; readonly version: 1 }[] }[]
  readonly occurrences: readonly TranslationSourceRange[]
  readonly occurrenceCount: number
  readonly occurrenceSamples: 'bounded_analysis_samples'
  readonly origin: 'model_inferred'
}
export interface PreparationFrozenTerm {
  readonly ref: PreparationTermRef
  readonly sourceForms: readonly string[]
  readonly aliases: readonly string[]
  readonly preferred: string
  readonly description: string
  readonly sourceLanguage: string | null
  readonly targetLanguage: string
  readonly sense: string
  readonly forbidden: readonly string[]
  readonly userFixed: boolean
  readonly confirmation: TermUserAdoption | null
  readonly origin: 'model_inferred' | 'main_model_adjusted' | 'inferred' | 'source_checked' | 'user_explicit'
  /** Topic evidence remains its real reference; analysis never invents a unit. */
  readonly evidence: readonly TermEvidenceRef[]
  readonly candidateRefs: readonly { readonly id: string; readonly version: 1; readonly callId: string }[]
  readonly ranges: readonly TranslationSourceRange[]
}
export interface PreparationConflict {
  readonly code: 'candidate_scope_unresolved' | 'fixed_scope_unresolved' | 'fixed_conflict' | 'term_scope_conflict' | 'question_unresolved'
  readonly original: string
  readonly refs: readonly PreparationTermRef[]
  readonly ranges: readonly TranslationSourceRange[]
  readonly message: string
}
export interface PreparationMechanicalCoverage {
  readonly meaning: 'mechanical_source_scan'
  readonly analysisId: string
  readonly analysisVersion: 1
  readonly requestedRanges: readonly TranslationSourceRange[]
  readonly excludedRanges: readonly TranslationSourceRange[]
  readonly requiredRanges: readonly TranslationSourceRange[]
  readonly coverage: readonly AnalysisCoverage[]
  readonly complete: boolean
}
export interface PreparationModelReview {
  readonly meaning: 'main_model_declared_review'
  readonly reviewedRanges: readonly TranslationSourceRange[]
  readonly complete: boolean
}
/** Immutable audit baseline. Source and external-reference bodies are never copied here. */
export interface PreparationSnapshot {
  readonly schemaVersion: 1
  readonly id: string
  readonly version: number
  readonly target: NormalTranslationTarget
  readonly scope: TranslationSourceScope
  readonly sourceVersion: number
  readonly sourceSha256: string
  readonly totalCodePoints: number
  readonly route: TranslationMaterialRoute
  readonly targetLanguage: string
  readonly userRequirements: string
  readonly organizedRequirements: string
  readonly mechanicalCoverage: PreparationMechanicalCoverage
  readonly modelReview: PreparationModelReview
  readonly correctionReview?: PreparationCorrectionReview
  readonly terms: readonly PreparationFrozenTerm[]
  readonly backgroundRanges: readonly TranslationSourceRange[]
  readonly referenceRefs: readonly PreparationReferenceRef[]
  readonly questions: readonly PreparationQuestion[]
  readonly conflicts: readonly PreparationConflict[]
  readonly preparationReady: boolean
  readonly executionReady: false
  readonly executionGate: 'plan_and_budget_pending'
  readonly storage: 'saved' | 'runtime_only'
  readonly storageError: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly operationId: string
}
export interface PreparationReceipt {
  readonly preparationId: string
  readonly version: number
  readonly target: NormalTranslationTarget
  readonly scope: TranslationSourceScope
  readonly sourceVersion: number
  readonly route: TranslationMaterialRoute
  readonly totalCodePoints: number
  readonly preparationReady: boolean
  readonly executionReady: false
  readonly executionGate: 'plan_and_budget_pending'
  readonly issueCount: number
  readonly termCount: number
  readonly candidateCount: number
  readonly storage: 'saved' | 'runtime_only'
  readonly storageError: string | null
  readonly editable: boolean
  readonly restartExecutable: false
  readonly createdAt: string
  readonly updatedAt: string
}
export interface PreparationPage extends TranslationPreparationQuery {
  readonly section: PreparationSection
  readonly items: readonly unknown[]
  readonly nextCursor: string | null
}

function preparationInteger(value: unknown, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new TypeError('Invalid preparation integer')
}
function preparationRoute(value: unknown): TranslationMaterialRoute {
  exact(value, ['provider', 'model'], ['reasoningEffort']); text(value.provider, 300); text(value.model, 300)
  if (value.reasoningEffort !== undefined) text(value.reasoningEffort, 200)
  return { provider: value.provider, model: value.model, ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort }) }
}
function preparationTime(value: unknown): asserts value is string { text(value, 40); if (!Number.isFinite(Date.parse(value))) throw new TypeError('Invalid preparation time') }
function preparationList(value: unknown, maximum: number): asserts value is unknown[] { if (!Array.isArray(value) || value.length > maximum) throw new TypeError('Preparation list exceeds limit') }
function preparationRef(value: unknown): PreparationTermRef {
  exact(value, ['kind', 'id'], ['version', 'entryVersion']); text(value.id, 2048)
  if (value.kind === 'topic_term') { exact(value, ['kind', 'id', 'entryVersion']); preparationInteger(value.entryVersion); return { kind: 'topic_term', id: value.id, entryVersion: value.entryVersion } }
  exact(value, ['kind', 'id', 'version'])
  if (value.kind !== 'candidate' || value.version !== 1) throw new TypeError('Invalid preparation candidate ref')
  return { kind: 'candidate', id: value.id, version: 1 }
}
function preparationDescriptionRef(value: unknown): { readonly id: string; readonly version: 1 } {
  exact(value, ['id', 'version']); text(value.id, 2048); if (value.version !== 1) throw new TypeError('Invalid candidate description ref')
  return { id: value.id, version: 1 }
}
function preparationQuestions(value: unknown): readonly PreparationQuestion[] {
  preparationList(value, 50)
  const result = value.map(item => {
    exact(item, ['id', 'question', 'ranges', 'decision']); text(item.id, 2048); text(item.question, 2000)
    if (item.decision !== null) text(item.decision, 2000)
    return { id: item.id, question: item.question, ranges: ranges(item.ranges), decision: item.decision as string | null }
  })
  if (new Set(result.map(item => item.id)).size !== result.length) throw new TypeError('Duplicate preparation question')
  return result
}
function preparationReferences(value: unknown): readonly PreparationReferenceRef[] {
  preparationList(value, 32)
  return value.map(item => { exact(item, ['id', 'version', 'range']); text(item.id, 2048); preparationInteger(item.version); return { id: item.id, version: item.version, range: range(item.range) } })
}
export function preparationPacketBytes(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).byteLength }
function preparationPacket(value: unknown): void { if (preparationPacketBytes(value) > MAX_PREPARATION_PACKET_BYTES) throw new TypeError('Preparation packet exceeds transport budget') }
export function parseTranslationPreparationPrepare(value: unknown): TranslationPreparationPrepare {
  preparationPacket(value); exact(value, ['target', 'preparationId', 'operationId', 'analysisId', 'analysisVersion'])
  text(value.preparationId, 2048); text(value.operationId, 2048); text(value.analysisId, 2048)
  if (value.analysisVersion !== 1) throw new TypeError('Invalid preparation analysis version')
  return { target: target(value.target), preparationId: value.preparationId, operationId: value.operationId, analysisId: value.analysisId, analysisVersion: 1 }
}
function preparationSelections(value: unknown): readonly PreparationTermSelection[] {
  preparationList(value, 100)
  const termSelections = value.map(item => {
    exact(item, ['ref', 'ranges'], ['descriptionRef', 'content']); const selectedRanges = ranges(item.ranges)
    if (!selectedRanges.length) throw new TypeError('Selected term requires an applicability range')
    let content: PreparationTermSelection['content']
    if (item.content !== undefined) {
      exact(item.content, ['original', 'preferred'], ['description']); text(item.content.original, 500); text(item.content.preferred, 2000)
      if (item.content.description !== undefined) text(item.content.description, 2000, true)
      content = { original: item.content.original, preferred: item.content.preferred, ...(item.content.description === undefined ? {} : { description: item.content.description }) }
    }
    return { ref: preparationRef(item.ref), ranges: selectedRanges,
      ...(item.descriptionRef === undefined ? {} : { descriptionRef: preparationDescriptionRef(item.descriptionRef) }), ...(content === undefined ? {} : { content }) }
  })
  if (new Set(termSelections.map(item => JSON.stringify(item.ref))).size !== termSelections.length) throw new TypeError('Duplicate preparation term ref')
  return termSelections
}
export function parseTranslationPreparationSet(value: unknown): TranslationPreparationSet {
  preparationPacket(value); exact(value, ['target', 'preparationId', 'expectedVersion', 'operationId', 'organizedRequirements', 'termSelections', 'reviewedRanges'], ['backgroundRanges', 'referenceRefs', 'questions'])
  text(value.preparationId, 2048); text(value.operationId, 2048); text(value.organizedRequirements, 4000, true); preparationInteger(value.expectedVersion)
  const termSelections = preparationSelections(value.termSelections)
  return { target: target(value.target), preparationId: value.preparationId, expectedVersion: value.expectedVersion, operationId: value.operationId,
    organizedRequirements: value.organizedRequirements, termSelections, reviewedRanges: ranges(value.reviewedRanges),
    ...(value.backgroundRanges === undefined ? {} : { backgroundRanges: ranges(value.backgroundRanges) }),
    ...(value.referenceRefs === undefined ? {} : { referenceRefs: preparationReferences(value.referenceRefs) }),
    ...(value.questions === undefined ? {} : { questions: preparationQuestions(value.questions) }) }
}
export function parseTranslationPreparationQuery(value: unknown): TranslationPreparationQuery {
  exact(value, ['target', 'preparationId', 'version']); text(value.preparationId, 2048); preparationInteger(value.version)
  return { target: parseNormalTranslationTarget(value.target), preparationId: value.preparationId, version: value.version }
}
export function parseTranslationPreparationCorrectionReview(value: unknown): TranslationPreparationCorrectionReview {
  preparationPacket(value); exact(value, ['target', 'preparationId', 'expectedVersion', 'operationId', 'basis', 'organizedRequirements', 'termSelections', 'reviewedRanges'], ['excludedRanges', 'backgroundRanges', 'questions'])
  const sourceTarget = parseNormalTranslationTarget(value.target)
  if (sourceTarget.kind !== 'unit') throw new TypeError('Correction review requires a real document unit')
  text(value.basis, 2000); text(value.preparationId, 2048); text(value.operationId, 2048); text(value.organizedRequirements, 4000, true); preparationInteger(value.expectedVersion)
  return { target: sourceTarget, preparationId: value.preparationId, expectedVersion: value.expectedVersion, operationId: value.operationId, organizedRequirements: value.organizedRequirements,
    termSelections: preparationSelections(value.termSelections), reviewedRanges: ranges(value.reviewedRanges), basis: value.basis,
    ...(value.excludedRanges === undefined ? {} : { excludedRanges: ranges(value.excludedRanges) }), ...(value.backgroundRanges === undefined ? {} : { backgroundRanges: ranges(value.backgroundRanges) }), ...(value.questions === undefined ? {} : { questions: preparationQuestions(value.questions) }) }
}
export function parsePreparationCorrectionReviewFacts(value: unknown): PreparationCorrectionReviewFacts {
  preparationPacket(value); exact(value, ['scope', 'unitId', 'sourceVersion', 'sourceSha256', 'totalCodePoints', 'correctionOperationId', 'analysisActualCalls', 'topicTerms', 'termMatches', 'relevantFixedIds'])
  const scope = parseTranslationSourceScope(value.scope), topicTerms = decodeTopicTermSnapshot(value.topicTerms)
  text(value.unitId, 2048); text(value.correctionOperationId, 2048); preparationInteger(value.sourceVersion); preparationInteger(value.totalCodePoints)
  if (typeof value.sourceSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(value.sourceSha256) || !topicTerms || topicTerms.ownerId !== scope.ownerId || topicTerms.topicId !== scope.topicId) throw new TypeError('Invalid correction review source or terms')
  if (value.analysisActualCalls !== null) preparationInteger(value.analysisActualCalls, 0, MAX_ANALYSIS_CALLS)
  preparationList(value.termMatches, 100)
  const termMatches = value.termMatches.map(item => { exact(item, ['ref', 'matched']); if (typeof item.matched !== 'boolean') throw new TypeError('Invalid source term match'); return { ref: preparationRef(item.ref), matched: item.matched } })
  const relevantFixedIds = preparationStrings(value.relevantFixedIds, 2048)
  if (new Set(termMatches.map(item => JSON.stringify(item.ref))).size !== termMatches.length) throw new TypeError('Duplicate correction review match')
  return { scope, unitId: value.unitId, sourceVersion: value.sourceVersion, sourceSha256: value.sourceSha256, totalCodePoints: value.totalCodePoints, correctionOperationId: value.correctionOperationId,
    analysisActualCalls: value.analysisActualCalls as number | null, topicTerms, termMatches, relevantFixedIds }
}
export function parseTranslationPreparationRead(value: unknown): TranslationPreparationRead {
  exact(value, ['target', 'preparationId', 'version', 'section'], ['cursor', 'limit'])
  const query = parseTranslationPreparationQuery({ target: value.target, preparationId: value.preparationId, version: value.version })
  if (!['summary', 'candidates', 'terms', 'coverage', 'background', 'references', 'questions', 'conflicts', 'correction_review'].includes(String(value.section))) throw new TypeError('Invalid preparation section')
  if (value.cursor !== undefined) text(value.cursor, 300)
  if (value.limit !== undefined) preparationInteger(value.limit, 1, MAX_PREPARATION_PAGE_ITEMS)
  return { ...query, section: value.section as PreparationSection, ...(value.cursor === undefined ? {} : { cursor: value.cursor }), ...(value.limit === undefined ? {} : { limit: value.limit as number }) }
}
export function parsePreparationAnalysisFacts(value: unknown): PreparationAnalysisFacts {
  preparationPacket(value); exact(value, ['run', 'candidates', 'coverage'])
  const raw = value.run
  exact(raw, ['analysisId', 'version', 'operationId', 'target', 'scope', 'sourceVersion', 'route', 'status', 'totalCodePoints', 'requestedRanges', 'excludedRanges', 'coverageComplete', 'coverageMeaning', 'completedCodePoints', 'candidateCount', 'plannedCalls', 'actualCalls', 'error', 'notification', 'storage', 'createdAt', 'updatedAt'])
  text(raw.analysisId, 2048); text(raw.operationId, 2048); preparationInteger(raw.sourceVersion); preparationInteger(raw.totalCodePoints)
  if (raw.version !== 1 || raw.coverageMeaning !== 'mechanical_source_scan' || raw.storage !== 'runtime_only' || typeof raw.coverageComplete !== 'boolean' || !['frozen', 'preparing', 'running', 'completed', 'failed', 'unknown'].includes(String(raw.status))) throw new TypeError('Invalid analysis facts')
  for (const item of [raw.completedCodePoints, raw.candidateCount, raw.plannedCalls, raw.actualCalls]) preparationInteger(item, 0)
  if ((raw.plannedCalls as number) > MAX_ANALYSIS_CALLS || (raw.actualCalls as number) > MAX_ANALYSIS_CALLS || (raw.completedCodePoints as number) > (raw.totalCodePoints as number)) throw new TypeError('Invalid analysis counters')
  exact(raw.notification, ['state', 'reason'])
  if (!['pending', 'enqueued', 'claimed', 'discarded', 'unavailable'].includes(String(raw.notification.state))) throw new TypeError('Invalid analysis notification')
  if (raw.notification.reason !== null) text(raw.notification.reason, 4000, true)
  if (raw.error !== null) { exact(raw.error, ['code', 'message', 'stage']); text(raw.error.code, 2048); text(raw.error.message, 4000); text(raw.error.stage, 2048) }
  preparationTime(raw.createdAt); preparationTime(raw.updatedAt)
  const run: AnalysisRun = { ...(structuredClone(raw) as unknown as AnalysisRun), target: target(raw.target), scope: parseTranslationSourceScope(raw.scope), route: preparationRoute(raw.route), requestedRanges: ranges(raw.requestedRanges), excludedRanges: ranges(raw.excludedRanges) }
  preparationList(value.candidates, MAX_ANALYSIS_CALLS * MAX_ANALYSIS_CANDIDATES_PER_CALL); preparationList(value.coverage, MAX_ANALYSIS_CALLS)
  const candidates = value.candidates.map(item => {
    exact(item, ['id', 'version', 'analysisId', 'callId', 'sourceVersion', 'occurrences', 'occurrenceCount', 'occurrenceSamples', 'origin', 'original', 'suggestedTranslation'], ['description'])
    for (const id of [item.id, item.analysisId, item.callId]) text(id, 2048)
    preparationInteger(item.sourceVersion); preparationInteger(item.occurrenceCount); preparationList(item.occurrences, 8)
    const content = parseAnalysisCandidateOutput(JSON.stringify({ candidates: [{ original: item.original, suggestedTranslation: item.suggestedTranslation, ...(item.description === undefined ? {} : { description: item.description }) }] }))[0]!
    const occurrences = item.occurrences.map(range)
    if (item.version !== 1 || item.origin !== 'model_inferred' || item.occurrenceSamples !== 'first_8_exact_matches' || !occurrences.length || item.occurrenceCount < occurrences.length || item.analysisId !== run.analysisId || item.sourceVersion !== run.sourceVersion) throw new TypeError('Candidate identity differs from analysis')
    return { ...content, id: item.id as string, version: 1 as const, analysisId: item.analysisId as string, callId: item.callId as string, sourceVersion: item.sourceVersion, occurrences, occurrenceCount: item.occurrenceCount, occurrenceSamples: 'first_8_exact_matches' as const, origin: 'model_inferred' as const }
  })
  const coverage = value.coverage.map(item => { exact(item, ['callId', 'range', 'candidateCount']); text(item.callId, 2048); preparationInteger(item.candidateCount, 0); return { callId: item.callId, range: range(item.range), candidateCount: item.candidateCount } })
  if (new Set(candidates.map(item => item.id)).size !== candidates.length || new Set(coverage.map(item => item.callId)).size !== coverage.length || run.candidateCount !== candidates.length) throw new TypeError('Invalid analysis fact counts')
  return { run, candidates, coverage }
}
export function parsePreparationCurrentFacts(value: unknown): PreparationCurrentFacts {
  exact(value, ['envelope', 'topicTerms']); const envelope = parseTranslationMaterialEnvelope(value.envelope), topicTerms = decodeTopicTermSnapshot(value.topicTerms)
  if (envelope.kind !== 'material' || !topicTerms || topicTerms.ownerId !== envelope.ownerId || topicTerms.topicId !== envelope.material.topicId) throw new TypeError('Invalid preparation current facts')
  return { envelope, topicTerms }
}
export function parsePreparationReceipt(value: unknown): PreparationReceipt {
  exact(value, ['preparationId', 'version', 'target', 'scope', 'sourceVersion', 'route', 'totalCodePoints', 'preparationReady', 'executionReady', 'executionGate', 'issueCount', 'termCount', 'candidateCount', 'storage', 'storageError', 'editable', 'restartExecutable', 'createdAt', 'updatedAt'])
  text(value.preparationId, 2048); preparationInteger(value.version); preparationInteger(value.sourceVersion); preparationInteger(value.totalCodePoints)
  for (const number of [value.issueCount, value.termCount, value.candidateCount]) preparationInteger(number, 0)
  if (typeof value.preparationReady !== 'boolean' || typeof value.editable !== 'boolean' || value.executionReady !== false || value.executionGate !== 'plan_and_budget_pending' || value.restartExecutable !== false || !['saved', 'runtime_only'].includes(String(value.storage))) throw new TypeError('Invalid preparation receipt')
  if (value.storageError !== null) text(value.storageError, 4000)
  preparationTime(value.createdAt); preparationTime(value.updatedAt)
  const result = { ...(structuredClone(value) as unknown as PreparationReceipt), target: parseNormalTranslationTarget(value.target), scope: parseTranslationSourceScope(value.scope), route: preparationRoute(value.route) }
  if (result.target.mainSessionId !== result.scope.mainSessionId || result.target.sourceVersion !== result.sourceVersion) throw new TypeError('Preparation receipt source mismatch')
  return result
}
export function parsePreparationPage(value: unknown): PreparationPage {
  exact(value, ['target', 'preparationId', 'version', 'section', 'items', 'nextCursor'])
  const query = parseTranslationPreparationRead({ target: value.target, preparationId: value.preparationId, version: value.version, section: value.section })
  preparationList(value.items, MAX_PREPARATION_PAGE_ITEMS)
  if (value.nextCursor !== null) text(value.nextCursor, 300)
  if (preparationPacketBytes({ ok: true, value }) > MAX_PREPARATION_PAGE_BYTES) throw new TypeError('Preparation page exceeds reply budget')
  const items = value.items.map(item => parsePreparationPageItem(query.section, item))
  return { target: query.target, preparationId: query.preparationId, version: query.version, section: query.section, items, nextCursor: value.nextCursor as string | null }
}

function preparationStrings(value: unknown, maximum: number, required = false): readonly string[] {
  preparationList(value, 100); value.forEach(item => text(item, maximum))
  if ((required && !value.length) || new Set(value).size !== value.length) throw new TypeError('Invalid preparation string list')
  return value as string[]
}
function candidateSourceRefs(value: unknown): readonly { readonly id: string; readonly version: 1; readonly callId: string }[] {
  preparationList(value, 2)
  return value.map(item => { exact(item, ['id', 'version', 'callId']); text(item.id, 2048); text(item.callId, 2048); if (item.version !== 1) throw new TypeError('Invalid analysis source ref'); return { id: item.id, version: 1, callId: item.callId } })
}
function parseFrozenPreparationTerm(value: unknown): PreparationFrozenTerm {
  exact(value, ['ref', 'sourceForms', 'aliases', 'preferred', 'description', 'sourceLanguage', 'targetLanguage', 'sense', 'forbidden', 'userFixed', 'confirmation', 'origin', 'evidence', 'candidateRefs', 'ranges'])
  const ref = preparationRef(value.ref), sourceForms = preparationStrings(value.sourceForms, 500, true), aliases = preparationStrings(value.aliases, 500), forbidden = preparationStrings(value.forbidden, 4000)
  text(value.preferred, ref.kind === 'candidate' ? 2000 : 4000); text(value.description, 4000, true); text(value.sense, 4000, true); text(value.targetLanguage, 80)
  if (value.sourceLanguage !== null) text(value.sourceLanguage, 80)
  if (typeof value.userFixed !== 'boolean' || forbidden.includes(value.preferred)) throw new TypeError('Invalid frozen preparation rule')
  preparationList(value.evidence, 100)
  const candidateRefs = candidateSourceRefs(value.candidateRefs), selectedRanges = ranges(value.ranges)
  if (!selectedRanges.length) throw new TypeError('Frozen term has no semantic scope')
  if (ref.kind === 'candidate') {
    if (!['model_inferred', 'main_model_adjusted'].includes(String(value.origin)) || value.userFixed || value.confirmation !== null || value.evidence.length || !candidateRefs.length || sourceForms.length !== 1 || aliases.length || value.sourceLanguage !== null || value.sense !== '' || forbidden.length) throw new TypeError('Candidate cannot fabricate topic or fixed evidence')
  } else {
    const auditTime = '2000-01-01T00:00:00.000Z', decoded = decodeTopicTermSnapshot({ schemaVersion: 1, ownerId: 'audit', topicId: 'audit', version: ref.entryVersion,
      activeVersion: ref.entryVersion, updatedAt: auditTime, entries: [{ id: ref.id, version: ref.entryVersion, sourceLanguage: value.sourceLanguage, targetLanguage: value.targetLanguage,
        sourceForms, aliases, sense: value.sense, preferred: value.preferred, forbidden, evidence: value.evidence, status: 'active', origin: value.origin, confirmation: value.confirmation, createdAt: auditTime, updatedAt: auditTime }] })
    if (!decoded || candidateRefs.length || value.description !== value.sense || value.userFixed !== (decoded.entries[0]!.confirmation !== null)) throw new TypeError('Invalid fixed topic term facts')
  }
  return { ...(structuredClone(value) as unknown as PreparationFrozenTerm), ref, sourceForms, aliases, forbidden, candidateRefs, ranges: selectedRanges }
}
function parsePreparationConflict(value: unknown): PreparationConflict {
  exact(value, ['code', 'original', 'refs', 'ranges', 'message']); text(value.original, 500, true); text(value.message, 2000)
  if (!['candidate_scope_unresolved', 'fixed_scope_unresolved', 'fixed_conflict', 'term_scope_conflict', 'question_unresolved'].includes(String(value.code))) throw new TypeError('Invalid preparation conflict')
  preparationList(value.refs, 512); preparationList(value.ranges, 512)
  return { code: value.code as PreparationConflict['code'], original: value.original, refs: value.refs.map(preparationRef), ranges: value.ranges.map(range), message: value.message }
}
function parsePreparationPageItem(section: PreparationSection, value: unknown): unknown {
  switch (section) {
    case 'correction_review': return parsePreparationCorrectionReview(value)
    case 'terms': return parseFrozenPreparationTerm(value)
    case 'conflicts': return parsePreparationConflict(value)
    case 'questions': return preparationQuestions([value])[0]!
    case 'references': return preparationReferences([value])[0]!
    case 'summary': {
      exact(value, ['userRequirements', 'organizedRequirements', 'route', 'sourceSha256', 'targetLanguage', 'mechanicalCoverageComplete', 'mainModelReviewComplete', 'preparationReady', 'executionReady', 'executionGate', 'coverageMeaning', 'reviewMeaning'], ['analysisSourceVersion', 'correctionReviewComplete'])
      text(value.userRequirements, 4000, true); text(value.organizedRequirements, 4000, true); text(value.targetLanguage, 80)
      if (typeof value.sourceSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(value.sourceSha256) || [value.mechanicalCoverageComplete, value.mainModelReviewComplete, value.preparationReady].some(item => typeof item !== 'boolean') || value.executionReady !== false || value.executionGate !== 'plan_and_budget_pending' || value.coverageMeaning !== 'mechanical_source_scan' || value.reviewMeaning !== 'main_model_declared_review') throw new TypeError('Invalid preparation summary')
      if (value.analysisSourceVersion !== undefined) preparationInteger(value.analysisSourceVersion)
      if (value.correctionReviewComplete !== undefined && typeof value.correctionReviewComplete !== 'boolean') throw new TypeError('Invalid correction review summary')
      return { ...structuredClone(value), route: preparationRoute(value.route) }
    }
    case 'background': {
      exact(value, ['target', 'sourceVersion', 'range', 'role']); const source = parseNormalTranslationTarget(value.target); preparationInteger(value.sourceVersion)
      if (value.sourceVersion !== source.sourceVersion || value.role !== 'source_background') throw new TypeError('Background is not an external reference')
      return { target: source, sourceVersion: value.sourceVersion, range: range(value.range), role: 'source_background' }
    }
    case 'coverage': {
      exact(value, ['kind', 'range'], ['analysisId', 'analysisVersion', 'callId', 'candidateCount', 'sourceVersion'])
      const scannedRange = range(value.range)
      if (value.sourceVersion !== undefined) preparationInteger(value.sourceVersion)
      if (value.kind === 'mechanical_scan') {
        exact(value, ['kind', 'range', 'analysisId', 'analysisVersion', 'callId', 'candidateCount'], ['sourceVersion']); text(value.analysisId, 2048); text(value.callId, 2048); preparationInteger(value.candidateCount, 0)
        if (value.analysisVersion !== 1) throw new TypeError('Invalid mechanical analysis ref')
        return { ...structuredClone(value), range: scannedRange }
      }
      exact(value, ['kind', 'range'], ['sourceVersion'])
      if (!['required', 'excluded', 'main_model_declared_review'].includes(String(value.kind))) throw new TypeError('Invalid preparation coverage meaning')
      return { kind: value.kind, range: scannedRange, ...(value.sourceVersion === undefined ? {} : { sourceVersion: value.sourceVersion }) }
    }
    case 'candidates': {
      exact(value, ['kind'], ['id', 'version', 'original', 'preferred', 'memberCount', 'descriptionCount', 'occurrences', 'occurrenceCount', 'occurrenceSamples', 'origin', 'candidateId', 'description', 'descriptionRef', 'callId'])
      if (value.kind === 'candidate') {
        exact(value, ['kind', 'id', 'version', 'original', 'preferred', 'memberCount', 'descriptionCount', 'occurrences', 'occurrenceCount', 'occurrenceSamples', 'origin'])
        text(value.id, 2048); text(value.original, 500); text(value.preferred, 2000)
        for (const count of [value.memberCount, value.descriptionCount, value.occurrenceCount]) preparationInteger(count)
        preparationList(value.occurrences, 8)
        if (value.version !== 1 || value.origin !== 'model_inferred' || value.occurrenceSamples !== 'bounded_analysis_samples') throw new TypeError('Invalid candidate projection')
        return { ...structuredClone(value), occurrences: value.occurrences.map(range) }
      }
      text(value.candidateId, 2048)
      if (value.kind === 'description') { exact(value, ['kind', 'candidateId', 'description', 'descriptionRef']); text(value.description, 2000, true); return { kind: 'description', candidateId: value.candidateId, description: value.description, descriptionRef: preparationDescriptionRef(value.descriptionRef) } }
      if (value.kind === 'analysis_source') { exact(value, ['kind', 'candidateId', 'id', 'version', 'callId']); const ref = candidateSourceRefs([{ id: value.id, version: value.version, callId: value.callId }])[0]!; return { kind: 'analysis_source', candidateId: value.candidateId, ...ref } }
      throw new TypeError('Invalid candidate fact kind')
    }
  }
}
function parsePreparationCorrectionReview(value: unknown): PreparationCorrectionReview {
  exact(value, ['meaning', 'previousPreparationRef', 'correctionOperationId', 'basis', 'analysisBasis', 'requiredRanges', 'excludedRanges', 'fixedTermVersions', 'termMappings', 'complete'])
  if (value.meaning !== 'main_model_correction_review' || typeof value.complete !== 'boolean') throw new TypeError('Invalid correction review meaning')
  exact(value.previousPreparationRef, ['id', 'version']); text(value.previousPreparationRef.id, 2048); preparationInteger(value.previousPreparationRef.version)
  text(value.correctionOperationId, 2048); text(value.basis, 2000)
  const analysis = value.analysisBasis
  exact(analysis, ['sourceVersion', 'sourceSha256', 'totalCodePoints', 'actualCalls']); preparationInteger(analysis.sourceVersion); preparationInteger(analysis.totalCodePoints)
  if (typeof analysis.sourceSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(analysis.sourceSha256)) throw new TypeError('Invalid original analysis identity')
  if (analysis.actualCalls !== null) preparationInteger(analysis.actualCalls, 0, MAX_ANALYSIS_CALLS)
  if (!value.fixedTermVersions || typeof value.fixedTermVersions !== 'object' || Array.isArray(value.fixedTermVersions)) throw new TypeError('Invalid fixed rule baseline')
  for (const [id, version] of Object.entries(value.fixedTermVersions)) { text(id, 2048); preparationInteger(version) }
  preparationList(value.termMappings, 100)
  const termMappings = value.termMappings.map(item => { exact(item, ['previous', 'current']); return { previous: preparationRef(item.previous), current: item.current === null ? null : preparationRef(item.current) } })
  preparationList(value.requiredRanges, MAX_ANALYSIS_RANGES + 1)
  return { ...(structuredClone(value) as unknown as PreparationCorrectionReview), requiredRanges: value.requiredRanges.map(range), excludedRanges: ranges(value.excludedRanges), termMappings }
}
function preparationCovers(actual: readonly TranslationSourceRange[], required: readonly TranslationSourceRange[]): boolean {
  const sorted = [...actual].sort((a, b) => a.start - b.start)
  return required.every(item => { let end = item.start; for (const part of sorted) { if (part.end <= end) continue; if (part.start > end) break; end = part.end; if (end >= item.end) return true } return false })
}
export function parsePreparationSnapshot(value: unknown): PreparationSnapshot {
  preparationPacket(value)
  exact(value, ['schemaVersion', 'id', 'version', 'target', 'scope', 'sourceVersion', 'sourceSha256', 'totalCodePoints', 'route', 'targetLanguage', 'userRequirements', 'organizedRequirements', 'mechanicalCoverage', 'modelReview', 'terms', 'backgroundRanges', 'referenceRefs', 'questions', 'conflicts', 'preparationReady', 'executionReady', 'executionGate', 'storage', 'storageError', 'createdAt', 'updatedAt', 'operationId'], ['correctionReview'])
  text(value.id, 2048); preparationInteger(value.version); preparationInteger(value.sourceVersion); preparationInteger(value.totalCodePoints); text(value.operationId, 2048)
  text(value.targetLanguage, 80); text(value.userRequirements, 4000, true); text(value.organizedRequirements, 4000, true); preparationTime(value.createdAt); preparationTime(value.updatedAt)
  const sourceTarget = parseNormalTranslationTarget(value.target), scope = parseTranslationSourceScope(value.scope), correction = value.correctionReview === undefined ? undefined : parsePreparationCorrectionReview(value.correctionReview)
  if (sourceTarget.kind === 'unit' && (!correction || sourceTarget.translationSessionId !== scope.translationSessionId) || correction && (sourceTarget.kind !== 'unit' || correction.previousPreparationRef.id !== value.id || correction.previousPreparationRef.version !== value.version - 1 || correction.analysisBasis.sourceVersion >= value.sourceVersion)) throw new TypeError('Invalid corrected preparation identity')
  if (value.schemaVersion !== 1 || value.sourceVersion !== sourceTarget.sourceVersion || sourceTarget.mainSessionId !== scope.mainSessionId || typeof value.sourceSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(value.sourceSha256) || value.executionReady !== false || value.executionGate !== 'plan_and_budget_pending' || !['saved', 'runtime_only'].includes(String(value.storage)) || typeof value.preparationReady !== 'boolean') throw new TypeError('Invalid preparation snapshot identity')
  if (value.storageError !== null) text(value.storageError, 4000)
  const mechanical = value.mechanicalCoverage, review = value.modelReview
  exact(mechanical, ['meaning', 'analysisId', 'analysisVersion', 'requestedRanges', 'excludedRanges', 'requiredRanges', 'coverage', 'complete'])
  text(mechanical.analysisId, 2048)
  if (mechanical.meaning !== 'mechanical_source_scan' || mechanical.analysisVersion !== 1 || typeof mechanical.complete !== 'boolean') throw new TypeError('Invalid mechanical coverage')
  const requested = ranges(mechanical.requestedRanges), excluded = ranges(mechanical.excludedRanges)
  preparationList(mechanical.requiredRanges, 257); const required = mechanical.requiredRanges.map(range)
  const expectedRequired: TranslationSourceRange[] = []; let start = 0
  for (const item of excluded) { if (start < item.start) expectedRequired.push({ start, end: item.start }); start = item.end }
  const analysisTotal = correction?.analysisBasis.totalCodePoints ?? value.totalCodePoints
  if (start < analysisTotal) expectedRequired.push({ start, end: analysisTotal })
  if (JSON.stringify(required) !== JSON.stringify(expectedRequired) || requested.some(item => excluded.some(skip => item.start < skip.end && skip.start < item.end))) throw new TypeError('Invalid source partition')
  preparationList(mechanical.coverage, MAX_ANALYSIS_CALLS)
  const coverage = mechanical.coverage.map(item => { exact(item, ['callId', 'range', 'candidateCount']); text(item.callId, 2048); preparationInteger(item.candidateCount, 0); return { callId: item.callId, range: range(item.range), candidateCount: item.candidateCount } })
  if (new Set(coverage.map(item => item.callId)).size !== coverage.length || coverage.some(item => !preparationCovers(requested, [item.range])) || mechanical.complete !== preparationCovers(coverage.map(item => item.range), required)) throw new TypeError('Invalid mechanical coverage completion')
  exact(review, ['meaning', 'reviewedRanges', 'complete']); const reviewed = ranges(review.reviewedRanges)
  const currentRequired = correction?.requiredRanges ?? required
  if (review.meaning !== 'main_model_declared_review' || review.complete !== preparationCovers(reviewed, currentRequired)) throw new TypeError('Invalid declared review completion')
  preparationList(value.terms, 100); const terms = value.terms.map(parseFrozenPreparationTerm), background = ranges(value.backgroundRanges), references = preparationReferences(value.referenceRefs), questions = preparationQuestions(value.questions)
  preparationList(value.conflicts, 1024); const conflicts = value.conflicts.map(parsePreparationConflict)
  if (references.length || terms.some(item => item.targetLanguage !== value.targetLanguage || !preparationCovers(currentRequired, item.ranges))) throw new TypeError('Invalid adopted scope or unsupported reference')
  if ([...requested, ...excluded, ...required, ...coverage.map(item => item.range)].some(item => item.end > analysisTotal)) throw new TypeError('Analysis range exceeds original source')
  if (correction) {
    const expected: TranslationSourceRange[] = []; let position = 0
    for (const skip of correction.excludedRanges) { if (position < skip.start) expected.push({ start: position, end: skip.start }); position = skip.end }
    if (position < value.totalCodePoints) expected.push({ start: position, end: value.totalCodePoints })
    if (JSON.stringify(expected) !== JSON.stringify(currentRequired) || correction.complete !== (review.complete && conflicts.length === 0)) throw new TypeError('Invalid corrected source coverage')
  }
  const allRanges = [...currentRequired, ...(correction?.excludedRanges ?? []), ...reviewed, ...background, ...terms.flatMap(item => item.ranges), ...questions.flatMap(item => item.ranges), ...conflicts.flatMap(item => item.ranges)]
  const total = value.totalCodePoints
  if (allRanges.some(item => item.end > total)) throw new TypeError('Preparation range exceeds source')
  if (value.preparationReady !== (value.version > 1 && (correction?.complete ?? (mechanical.complete && review.complete && conflicts.length === 0)))) throw new TypeError('Invalid preparation eligibility')
  return { ...(structuredClone(value) as unknown as PreparationSnapshot), target: sourceTarget, scope, route: preparationRoute(value.route), terms, backgroundRanges: background, referenceRefs: references, questions, conflicts,
    mechanicalCoverage: { meaning: 'mechanical_source_scan', analysisId: mechanical.analysisId, analysisVersion: 1, requestedRanges: requested, excludedRanges: excluded, requiredRanges: required, coverage, complete: mechanical.complete },
    modelReview: { meaning: 'main_model_declared_review', reviewedRanges: reviewed, complete: review.complete as boolean } }
}
