import { parseNormalTranslationTarget, parseNormalTranslationUnitRequest, type NormalTranslationMaterialTarget } from './normal-translation.js'
import { parseTranslationMaterialEnvelope, type TranslationMaterialRoute, type TranslationMaterialEnvelope } from './translation-material.js'
import type { TranslationSourceAsset, TranslationSourceScope, SourceIdentity } from './translation-sources.js'
import { parseLibrarySourceRequest, type LibrarySourceRequest } from './library-sources.js'
import type { TranslationSourceRange } from './translation-source-read.js'

export const MAX_FILE_JOB_PAGE_BYTES = 32768
export const MAX_FILE_JOB_TEXT_POINTS = 4000
/** Item cap is only a guard against pathological arrays; the 32768-byte page budget is the real bound. */
export const MAX_FILE_JOB_PAGE_ITEMS = 200
export type FileJobPhase = 'accepted' | 'preparing' | 'awaiting_baseline_review' | 'translating' | 'checking' | 'awaiting_review' | 'completed' | 'failed' | 'cancelled' | 'unknown'
export interface FileJobIdentity { readonly ownerId: string; readonly jobId: string }
export interface FileJobScope extends FileJobIdentity { readonly mainSessionId: string; readonly topicId: string; readonly translationSessionId: string }
export interface FileJobEvidence { readonly range: TranslationSourceRange }
interface ProposalBase { readonly candidateId: string; readonly origin: 'inferred' | 'source_checked'; readonly evidence: readonly FileJobEvidence[]; readonly disposition: 'pending' | 'accepted' | 'rejected' }
export type FileJobProposal = ProposalBase & (
  | { readonly kind: 'term'; readonly sourceForms: readonly string[]; readonly preferred: string; readonly description: string }
  | { readonly kind: 'entity'; readonly name: string; readonly aliases: readonly string[]; readonly description: string }
  | { readonly kind: 'fact'; readonly title: string; readonly body: string; readonly entityCandidateIds: readonly string[] }
  | { readonly kind: 'relation'; readonly sourceEntityCandidateId: string; readonly relation: string; readonly targetEntityCandidateId: string; readonly description: string }
)
export interface FileJobTerm { readonly source: string; readonly target: string; readonly description?: string; readonly ranges: readonly TranslationSourceRange[] }
export interface FileJobConstraint { readonly kind: 'topic_term' | 'topic_archive'; readonly id: string; readonly entryVersion: number; readonly userFixed: boolean; readonly content: unknown }
export interface FileJobContext { readonly range: TranslationSourceRange; readonly text: string }
export interface FileJobDelegatedReview { readonly workerId: string; readonly range: TranslationSourceRange; readonly reviewedRanges: readonly TranslationSourceRange[]; readonly issues: FileWorkerReviewOutput['issues'] }
export interface FileJobConflict { readonly id: string; readonly message: string; readonly ranges: readonly TranslationSourceRange[] }
export interface FileJobBaseline { readonly version: number; readonly context: string; readonly terms: readonly FileJobTerm[]; readonly conflicts: readonly FileJobConflict[]; readonly preparation: 'native_subagent'; readonly workerId: string; readonly topicAssetRefs: readonly { readonly id: string; readonly entryVersion: number }[] }
export interface FileJobWorker { readonly id: string; readonly kind: 'preparation' | 'translation' | 'review'; readonly status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'; readonly range: TranslationSourceRange | null; readonly startedAt: string | null; readonly completedAt: string | null; readonly provider?: string; readonly model?: string; readonly callId?: string; readonly inputTokens?: number; readonly outputTokens?: number; readonly native?: { readonly provider: string; readonly mode: 'one-shot' | 'activation'; readonly stopReason: 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'; readonly observedAttempts: number } }
export interface FileJobPlanItem { readonly id: string; readonly range: TranslationSourceRange; readonly status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'; readonly resultVersion: number | null }
export interface FileJobInputEstimate {
  readonly kind: 'estimated'; readonly stage: FileJobWorker['kind']; readonly inputBytes: number
  readonly contextWindow: number | null; readonly maxOutputTokens: number | null; readonly promptOverheadBytes: number
  readonly sourceTargetBytes: number; readonly provider: string | null; readonly model: string | null
}
export interface FileJobMechanicalIssue { readonly code: string; readonly message: string; readonly range: TranslationSourceRange | null; readonly inputEstimate?: FileJobInputEstimate }
export interface FileJobSummary extends Omit<FileJobScope, 'ownerId'> {
  readonly namespaceId?: string
  readonly operationId: string; readonly requestId: string; readonly materialId: string; readonly unitId: string; readonly sourceVersion: number
  readonly sourceRef?: TranslationSourceAsset; readonly sourceTotalCodePoints: number; readonly targetLanguage: string; readonly instruction: string; readonly model: TranslationMaterialRoute | null
  /** Frozen chat requirements; absent on records created before this field existed. */
  readonly organizedRequirements?: string
  readonly historyOrigin?: 'legacy_document'
  /** Exact stored source credentials; unrelated to the current execution main Session. */
  readonly sourceOrigin?: { readonly scope: TranslationSourceScope; readonly source: SourceIdentity; readonly referenceKey: string }
  readonly createdAt: string; readonly updatedAt: string; readonly version: number; readonly phase: FileJobPhase
  readonly progress: { readonly completed: number; readonly total: number }; readonly baselineVersion: number | null
  readonly execution?: { readonly mode: 'single' | 'partitioned'; readonly concurrency: 1 | 2; readonly preparationPartitions: number; readonly translationPartitions: number; readonly reviewPartitions: number }
  readonly delegatedCoverage?: { readonly reviewedCodePoints: number; readonly totalCodePoints: number; readonly complete: boolean }
  readonly result: { readonly version: number; readonly totalCodePoints: number; readonly semanticStatus: 'pending' | 'passed' | 'changes_requested' } | null
  readonly proposalBatch: { readonly id: string; readonly version: number; readonly count: number; readonly status: 'draft' | 'reviewed' } | null
  readonly review: { readonly version: number; readonly status: 'not_ready' | 'baseline_required' | 'required' | 'passed' | 'changes_requested'; readonly reviewedBy: string | null; readonly decidedAt: string | null }
  readonly notification: 'not_needed' | 'pending' | 'sent' | 'unavailable'
  readonly assetFeedback?: { readonly operationId: string; readonly batchVersion: number; readonly candidateIds: readonly string[]; readonly comment: string; readonly status: 'required' | 'reviewed' | 'changes_requested' }
  readonly removedAt?: string
  /** Transient feedback for the last accepted decision that did not advance the phase. */
  readonly notice?: string
  readonly error: { readonly code: string; readonly message: string; readonly stage: string } | null
}
export interface FileJobStart { readonly target: NormalTranslationMaterialTarget; readonly operationId: string; readonly organizedRequirements: string }
export interface FileJobRestart { readonly envelope: Extract<TranslationMaterialEnvelope, { kind: 'material' }>; readonly operationId: string; readonly previousResultVersion: number; readonly organizedRequirements?: string; readonly librarySource?: Pick<LibrarySourceRequest, 'stored' | 'namespaceId' | 'prepareToken'> }
export interface FileJobList { readonly ownerId: string; readonly translationSessionId?: string; readonly offset?: number; readonly limit?: number }
export interface FileJobControl extends FileJobIdentity { readonly action: 'cancel' | 'remove' }
export interface FileJobFeedback extends FileJobIdentity { readonly expectedBatchVersion: number; readonly candidateIds: readonly string[]; readonly comment: string; readonly operationId: string; readonly proposalEdits?: readonly FileJobProposal[] }
export interface FileJobReadReview extends FileJobIdentity { readonly section: 'source' | 'result' | 'results' | 'proposals' | 'baseline' | 'conflicts' | 'constraints' | 'contexts' | 'reviews' | 'plan' | 'workers' | 'checks'; readonly range?: TranslationSourceRange; readonly resultVersion?: number; readonly offset?: number; readonly limit?: number }
export interface FileJobReviewPage { readonly summary: FileJobSummary; readonly section: FileJobReadReview['section']; readonly text?: string; readonly range?: TranslationSourceRange; readonly items?: readonly (FileJobProposal | FileJobTerm | FileJobConflict | FileJobConstraint | FileJobContext | FileJobDelegatedReview | FileJobPlanItem | FileJobWorker | FileJobMechanicalIssue | { readonly version: number; readonly totalCodePoints: number; readonly semanticStatus: 'pending' | 'passed' | 'changes_requested' })[]; readonly context?: string; readonly feedback?: FileJobFeedback; readonly nextOffset: number | null; /** Total entries in this section, so one page plus nextOffset is always enough to know the size. */ readonly total?: number }
export interface FileJobTextEdit { readonly range?: TranslationSourceRange; readonly expectedText: string; readonly text: string; readonly replaceAll?: boolean }
export interface FileJobRevision extends FileJobIdentity { readonly expectedVersion: number; readonly operationId: string; readonly edits: readonly FileJobTextEdit[]; readonly comment: string }
export interface FileJobConflictResolution { readonly id?: string; readonly index?: number; readonly resolution: string }
export interface FileJobSemanticDecision extends FileJobIdentity {
  readonly expectedVersion: number; readonly stage: 'baseline' | 'final' | 'assets'; readonly decision: 'accept' | 'changes_requested'; readonly comment: string
  readonly edits?: readonly FileJobTextEdit[]; readonly rejectedCandidateIds?: readonly string[]; readonly proposalEdits?: readonly FileJobProposal[]
  readonly resolvedConflicts?: readonly FileJobConflictResolution[]
  readonly baselineTerms?: readonly FileJobTerm[]
  readonly baselineContext?: string; readonly orderedTranslation?: boolean
  /** Actual user wording resolving a conflict; never an LLM-authored requirement. */
  readonly userDecision?: string
}
export type FileJobResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly stage: string; readonly recoveredSource?: TranslationSourceAsset; /** Safe structured diagnostics (ids, field names, limits); never source text. */ readonly detail?: unknown } }
export interface FileJobsPort {
  start(request: FileJobStart): Promise<FileJobResult<FileJobSummary>>
  restart(request: FileJobRestart): Promise<FileJobResult<FileJobSummary>>
  read(request: FileJobIdentity): Promise<FileJobResult<FileJobSummary | null>>
  list(request: FileJobList): Promise<FileJobResult<{ readonly items: readonly FileJobSummary[]; readonly nextOffset: number | null }>>
  control(request: FileJobControl): Promise<FileJobResult<FileJobSummary>>
  readReview(request: FileJobReadReview): Promise<FileJobResult<FileJobReviewPage>>
  feedback(request: FileJobFeedback): Promise<FileJobResult<FileJobSummary>>
  submitUnit(request: import('./normal-translation.js').NormalTranslationUnitRequest): Promise<FileJobResult<{ readonly accepted: true; readonly operationId: string; readonly target: import('./normal-translation.js').NormalTranslationUnitTarget }>>
  queryUnit(request: import('./normal-translation.js').NormalTranslationUnitRequest): Promise<FileJobResult<{ readonly accepted: true; readonly operationId: string; readonly target: import('./normal-translation.js').NormalTranslationUnitTarget } | null>>
}

/** Input to a single native preparation task. All source strings are material, never instructions. */
export interface FileWorkerPreparationInput extends FileJobScope {
  readonly source: { readonly text: string; readonly version: number; readonly materialId: string }
  readonly targetLanguage: string; readonly instruction: string; readonly existingAssets: unknown; readonly assetLanguage?: string
}
export interface FileWorkerPreparationOutput {
  readonly terms: readonly FileJobTerm[]; readonly context: string; readonly proposals: readonly FileJobProposal[]; readonly conflicts: readonly FileJobConflict[]; readonly worker: FileJobWorker
  /** Safe preparation diagnostics: fixed reasons and array paths, never original source or model output. */
  readonly warnings?: readonly FileJobMechanicalIssue[]
}
export interface FileWorkerReviewInput extends FileJobScope { readonly source: { readonly text: string; readonly version: number; readonly materialId: string }; readonly translation: string; readonly targetLanguage: string; readonly instruction: string; readonly context: string; readonly terms: readonly FileJobTerm[]; readonly ranges: readonly TranslationSourceRange[] }
export interface FileWorkerReviewOutput { readonly reviewedRanges: readonly TranslationSourceRange[]; readonly issues: readonly { readonly severity: 'error' | 'warning'; readonly message: string; readonly range: TranslationSourceRange; readonly suggestion?: string }[]; readonly worker: FileJobWorker }

type Data = Record<string, unknown>
function object(value: unknown): asserts value is Data { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected file job object') }
function text(value: unknown): asserts value is string { if (typeof value !== 'string' || !value.trim() || value.length > 3000) throw new TypeError('Invalid file job identity') }
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): asserts value is number { if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new TypeError('Invalid file job number') }
function identity(value: Data): void { text(value.ownerId); text(value.jobId) }
function range(value: unknown): void { object(value); integer(value.start); integer(value.end, 1); if ((value.end as number) <= (value.start as number)) throw new TypeError('Invalid file job range') }
/** Models sometimes serialize arrays as JSON strings; accept that shape only after a strict parse. */
function list(value: unknown, maximum: number, field: string): unknown[] {
  let resolved = value
  if (typeof resolved === 'string') {
    try { resolved = JSON.parse(resolved) } catch { throw new TypeError(`${field} must be an array of objects, not a JSON string`) }
  }
  if (!Array.isArray(resolved)) throw new TypeError(`${field} must be an array of objects`)
  if (resolved.length > maximum) throw new TypeError(`${field} accepts at most ${maximum} items`)
  return resolved
}
const FILE_JOB_REVIEW_SECTIONS = ['source', 'result', 'results', 'proposals', 'baseline', 'conflicts', 'constraints', 'contexts', 'reviews', 'plan', 'workers', 'checks'] as const
export function parseFileJobRequest(method: 'start' | 'restart' | 'read' | 'list' | 'control' | 'readReview' | 'submitReview' | 'revise' | 'feedback' | 'submitUnit' | 'queryUnit', value: unknown): unknown {
  object(value)
  if (method === 'submitUnit' || method === 'queryUnit') return parseNormalTranslationUnitRequest(value)
  // Tool arguments arrive frozen. Normalize into an owned copy instead of writing back to the input.
  const data: Data = { ...value }
  if (method === 'restart') {
    const envelope = parseTranslationMaterialEnvelope(data.envelope)
    if (envelope.kind !== 'material' || !envelope.material.sourceRef) throw new TypeError('File restart requires frozen source')
    text(data.operationId); integer(data.previousResultVersion)
    if (data.organizedRequirements !== undefined && (typeof data.organizedRequirements !== 'string' || data.organizedRequirements.length > 4000)) throw new TypeError('Invalid restart requirements')
    let librarySource: FileJobRestart['librarySource']
    if (data.librarySource !== undefined) {
      object(data.librarySource)
      const proof = parseLibrarySourceRequest({ ...data.librarySource, action: 'page', range: { start: 0, end: Math.min(4000, envelope.material.sourceRef.totalCodePoints) } })
      librarySource = { stored: proof.stored, namespaceId: proof.namespaceId, prepareToken: proof.prepareToken }
    }
    return { envelope, operationId: data.operationId, previousResultVersion: data.previousResultVersion, ...(data.organizedRequirements === undefined ? {} : { organizedRequirements: data.organizedRequirements }), ...(librarySource ? { librarySource } : {}) }
  }
  if (method === 'start') {
    const target = parseNormalTranslationTarget(data.target)
    if (target.kind !== 'material') throw new TypeError('File job requires delivered material')
    text(data.operationId)
    if (typeof data.organizedRequirements !== 'string' || data.organizedRequirements.length > 4000) throw new TypeError('organizedRequirements is required; use an empty string only when there are no additional chat requirements')
    return { target, operationId: data.operationId, organizedRequirements: data.organizedRequirements }
  }
  if (method === 'list') { text(data.ownerId); if (data.translationSessionId !== undefined) text(data.translationSessionId) }
  else identity(data)
  if (data.offset !== undefined) integer(data.offset)
  // Out-of-range paging is clamped instead of rejected: the byte budget still bounds the reply.
  if (data.limit !== undefined) { integer(data.limit, 1); data.limit = Math.min(data.limit as number, MAX_FILE_JOB_PAGE_ITEMS) }
  if (data.resultVersion !== undefined) integer(data.resultVersion, 1)
  if (method === 'control' && data.action !== 'cancel' && data.action !== 'remove') throw new TypeError('Invalid file job control')
  if (method === 'readReview') { if (!(FILE_JOB_REVIEW_SECTIONS as readonly string[]).includes(data.section as string)) throw new TypeError(`Invalid file job section; expected one of ${FILE_JOB_REVIEW_SECTIONS.join(', ')}`); if (data.range !== undefined) range(data.range) }
  if (method === 'submitReview' || method === 'revise') {
    integer(data.expectedVersion, 1)
    if (typeof data.comment !== 'string' || data.comment.length > 4000) throw new TypeError('A comment string is required')
    if (method === 'submitReview' && (!['baseline', 'final', 'assets'].includes(data.stage as string) || !['accept', 'changes_requested'].includes(data.decision as string))) throw new TypeError('Invalid semantic decision; stage and decision are required')
    if (data.edits !== undefined) { const edits = list(data.edits, 40, 'edits'); for (const edit of edits) {
      object(edit); if (edit.range !== undefined) range(edit.range)
      if (typeof edit.expectedText !== 'string' || !edit.expectedText || edit.expectedText.length > 16000 || typeof edit.text !== 'string' || edit.text.length > 16000 || edit.replaceAll !== undefined && typeof edit.replaceAll !== 'boolean' || edit.range !== undefined && edit.replaceAll === true) throw new TypeError('Edits require exact expectedText and replacement text; range uses Unicode code points, never bytes')
    } data.edits = edits }
    if (method === 'revise') { text(data.operationId); if (!Array.isArray(data.edits) || !data.edits.length) throw new TypeError('Revision requires edits'); return structuredClone(data) }
    if (data.rejectedCandidateIds !== undefined) { const ids = list(data.rejectedCandidateIds, 1000, 'rejectedCandidateIds'); if (ids.some(id => typeof id !== 'string')) throw new TypeError('rejectedCandidateIds must contain strings'); data.rejectedCandidateIds = ids }
    if (data.proposalEdits !== undefined) data.proposalEdits = list(data.proposalEdits, 40, 'proposalEdits')
    if (data.resolvedConflicts !== undefined) { const conflicts = list(data.resolvedConflicts, 1000, 'resolvedConflicts'); for (const conflict of conflicts) {
      object(conflict)
      if (conflict.id !== undefined) text(conflict.id)
      if (conflict.index !== undefined) integer(conflict.index, 1)
      if (conflict.id === undefined && conflict.index === undefined) throw new TypeError('resolvedConflicts items need id or 1-based index')
      if (typeof conflict.resolution !== 'string' || !conflict.resolution.trim() || conflict.resolution.length > 4000) throw new TypeError('Invalid conflict resolution')
    } data.resolvedConflicts = conflicts }
    if (data.baselineTerms !== undefined) data.baselineTerms = list(data.baselineTerms, 500, 'baselineTerms')
    if (data.baselineContext !== undefined && (typeof data.baselineContext !== 'string' || data.baselineContext.length > 8000) || data.orderedTranslation !== undefined && typeof data.orderedTranslation !== 'boolean') throw new TypeError('Invalid baseline decision')
    if (data.userDecision !== undefined && (data.stage !== 'baseline' || typeof data.userDecision !== 'string' || !data.userDecision.trim() || data.userDecision.length > 4000)) throw new TypeError('userDecision requires actual user wording for a baseline conflict')
  }
  if (method === 'feedback') {
    integer(data.expectedBatchVersion, 1); text(data.operationId)
    const candidates = list(data.candidateIds, 1000, 'candidateIds')
    if (candidates.length < 1 || candidates.some(id => typeof id !== 'string')) throw new TypeError('Invalid card feedback; candidateIds must be a non-empty array of ids')
    if (typeof data.comment !== 'string' || !data.comment.trim() || data.comment.length > 4000) throw new TypeError('Invalid card feedback; comment is required')
    data.candidateIds = candidates
    if (data.proposalEdits !== undefined) data.proposalEdits = list(data.proposalEdits, 40, 'proposalEdits')
  }
  return structuredClone(data)
}
export function parseFileJobResult(value: unknown): unknown {
  object(value)
  if (value.ok !== true && value.ok !== false) throw new TypeError('Invalid file job result')
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_FILE_JOB_PAGE_BYTES) throw new TypeError('File job page exceeds transport budget')
  return structuredClone(value)
}
export const FILE_JOBS_REMOTE = { package: 'dsh-translation-plugin', descriptors: (['start', 'restart', 'read', 'list', 'control', 'readReview', 'feedback', 'submitUnit', 'queryUnit'] as const).map(method => ({
  id: `dsh-translation-plugin#translationFileJobs/${method}`, service: 'translationFileJobs', namespace: 'translationFileJobs', method,
  invocation: { kind: 'direct' as const }, parameters: [{ name: 'request', wire: 'request', source: 'json' as const,
    codec: { mode: 'strict' as const, typeSymbol: `dsh-translation-plugin#fileJobs/${method}Request`, create: () => ({ parse: (value: unknown) => parseFileJobRequest(method, value) }) } }],
  result: { mode: 'strict' as const, typeSymbol: `dsh-translation-plugin#fileJobs/${method}Result`, create: () => ({ parse: parseFileJobResult }) },
})) }
