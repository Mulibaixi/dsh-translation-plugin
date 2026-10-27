import { parseDocumentCorrectionFact, parseDocumentReuseApproval, parseDocumentReuseRequest, parseDocumentSourcePatches,
  type DocumentCorrectionFact, type DocumentCorrectionMapping, type DocumentReuseApproval, type DocumentReuseDependencyEvidence,
  type DocumentReuseRequest, type DocumentSourcePatch } from '../shared/document-correction.js'
import { documentSourceLength, sameVersionReference, type ChunkRevision, type DocumentCallContextReference,
  type DocumentChunkPlan, type DocumentSourceVersion, type DocumentSupplementFact, type DocumentUnit,
  type DocumentRevision, type ManifestEntry } from '../shared/translation-batch.js'
import { DOCUMENT_TRANSLATION_PROMPT_VERSION } from '../shared/document-planning.js'
import type { PreparationSnapshot } from '../shared/translation-preparation.js'
import type { TranslationSourceRange } from '../shared/translation-source-read.js'

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)
async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text), digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.buffer))
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
export interface DocumentPatchedSource {
  readonly text: string
  readonly oldLength: number
  readonly newLength: number
  readonly mappings: readonly DocumentCorrectionMapping[]
}
/** Work in Unicode code points, including BOM and supplementary characters. */
export async function applyDocumentSourcePatches(text: string, supplied: readonly DocumentSourcePatch[]): Promise<DocumentPatchedSource> {
  if (/[\uD800-\uDFFF]/u.test(text)) throw new TypeError('Invalid document source encoding')
  const points = Array.from(text), patches = parseDocumentSourcePatches(supplied, points.length), pieces: string[] = [], mappings: DocumentCorrectionMapping[] = []
  let end = 0, delta = 0
  for (const patch of patches) {
    pieces.push(points.slice(end, patch.range.start).join(''), patch.replacementText)
    const replacementLength = Array.from(patch.replacementText).length
    const newRange = { start: patch.range.start + delta, end: patch.range.start + delta + replacementLength }
    mappings.push({ oldRange: patch.range, newRange, replacementSha256: await sha256(patch.replacementText) })
    end = patch.range.end; delta += replacementLength - (patch.range.end - patch.range.start)
  }
  pieces.push(points.slice(end).join(''))
  const result = pieces.join('')
  if (!result.trim() || result === text || new TextEncoder().encode(result).byteLength > 2 * 1024 * 1024) throw new TypeError('Document correction must change a nonempty source within 2 MiB')
  return { text: result, oldLength: points.length, newLength: points.length + delta, mappings }
}
/** A boundary inside replaced content has no exact surviving position. */
export function mapDocumentCorrectionPosition(position: number, mappings: readonly DocumentCorrectionMapping[], bias: 'before' | 'after' = 'before'): number | null {
  let delta = 0
  for (const mapping of mappings) {
    const { oldRange, newRange } = mapping
    if (position < oldRange.start) break
    if (position === oldRange.start) return bias === 'after' ? newRange.end : newRange.start
    if (position < oldRange.end) return null
    delta += newRange.end - newRange.start - (oldRange.end - oldRange.start)
  }
  return position + delta
}
/** Returns only a wholly unchanged fragment. Edited ranges require an explicit new plan. */
export function mapDocumentCorrectionRange(range: TranslationSourceRange, mappings: readonly DocumentCorrectionMapping[]): TranslationSourceRange | null {
  for (const { oldRange } of mappings) {
    if (oldRange.start === oldRange.end ? oldRange.start > range.start && oldRange.start < range.end : oldRange.start < range.end && range.start < oldRange.end) return null
  }
  const start = mapDocumentCorrectionPosition(range.start, mappings, 'after'), end = mapDocumentCorrectionPosition(range.end, mappings, 'before')
  return start === null || end === null || start >= end ? null : { start, end }
}
function mappedRange(range: TranslationSourceRange, from: number, to: number, corrections: readonly DocumentCorrectionFact[]): TranslationSourceRange | null {
  let current: TranslationSourceRange | null = range
  for (let version = from; version < to; version++) {
    const correction = corrections.find(item => item.fromSourceVersion === version && item.toSourceVersion === version + 1)
    if (!correction || !current) return null
    current = mapDocumentCorrectionRange(current, correction.mappings)
  }
  return current
}
export interface DocumentReuseUnitFacts {
  readonly id: string
  readonly sourceVersion: number
  readonly sourceVersions: readonly DocumentSourceVersion[]
  readonly plans: readonly DocumentChunkPlan[]
  /** Host capture needs metadata and actual call facts, never the translated body. */
  readonly chunkRevisions: readonly (Omit<ChunkRevision, 'content'> & { readonly completeResult?: boolean })[]
  readonly corrections?: readonly DocumentCorrectionFact[]
}
export interface VerifyDocumentReuseInput {
  readonly unit: DocumentReuseUnitFacts
  readonly request: DocumentReuseRequest
  readonly id: string
  readonly operationId: string
  readonly createdAt: string
  readonly oldSourceText: string
  readonly newSourceText: string
  readonly oldPreparation: PreparationSnapshot
  readonly newPreparation: PreparationSnapshot
  readonly plan: DocumentChunkPlan
  readonly contextRef: DocumentCallContextReference
  readonly oldSupplements?: readonly DocumentSupplementFact[]
  readonly newSupplements?: readonly DocumentSupplementFact[]
}
function overlap(left: TranslationSourceRange, right: TranslationSourceRange): boolean { return left.start < right.end && right.start < left.end }
function selectedRules(preparation: PreparationSnapshot, context: DocumentCallContextReference, outputRange: TranslationSourceRange,
  supplements: readonly DocumentSupplementFact[], promptVersion: string | null, mode: 'translate' | 'copy'): unknown {
  const ranges = [outputRange, ...context.contextRanges]
  const terms = context.termRefs.map(reference => {
    const term = preparation.terms.find(term => same(term.ref, reference))
    if (!term) throw new TypeError('Document reuse lacks an actual selected term')
    return { ref: term.ref, sourceForms: term.sourceForms, aliases: term.aliases, preferred: term.preferred,
      description: term.description, sourceLanguage: term.sourceLanguage, targetLanguage: term.targetLanguage, sense: term.sense,
      forbidden: term.forbidden, userFixed: term.userFixed,
      applicableRanges: ranges.map(part => term.ranges.filter(range => overlap(range, part)).map(range => ({ start: Math.max(range.start, part.start) - part.start, end: Math.min(range.end, part.end) - part.start }))) }
  })
  // The current planner has no external-reference reader. Do not invent reference content.
  if (context.referenceRefs.length) throw new TypeError('Document reuse reference reader unavailable')
  const selectedSupplements = context.supplementRefs.map(reference => {
    const supplement = supplements.find(item => sameVersionReference(item, reference))
    if (!supplement) throw new TypeError('Document reuse lacks an actual resolved supplement')
    return { id: supplement.id, version: supplement.version, answerText: supplement.answerText, organizedRequirements: supplement.organizedRequirements, references: supplement.references }
  })
  return { mode, promptVersion, targetLanguage: preparation.targetLanguage, userRequirements: preparation.userRequirements,
    organizedRequirements: preparation.organizedRequirements, terms, references: context.referenceRefs, supplements: selectedSupplements }
}
async function dependencyEvidence(source: DocumentSourceVersion, text: string, preparation: PreparationSnapshot, plan: DocumentChunkPlan,
  range: TranslationSourceRange, contextRef: DocumentCallContextReference, supplements: readonly DocumentSupplementFact[], promptVersion: string | null,
  mode: 'translate' | 'copy'): Promise<DocumentReuseDependencyEvidence> {
  const points = Array.from(text), sourceSha256 = await sha256(text)
  if (/[\uD800-\uDFFF]/u.test(text) || points.length !== documentSourceLength(source) || preparation.sourceVersion !== source.version ||
    preparation.sourceSha256 !== sourceSha256 || (source.body.kind === 'asset' ? source.body.reference.sha256 !== sourceSha256 : source.body.text !== text) ||
    !sameVersionReference(contextRef.preparationRef, preparation) || plan.sourceVersion !== source.version || !sameVersionReference(plan.preparationRef, preparation)) throw new TypeError('Document reuse source or preparation identity changed')
  const slice = (part: TranslationSourceRange): string => {
    if (part.start < 0 || part.end > points.length || part.start >= part.end) throw new TypeError('Document reuse source range unavailable')
    return points.slice(part.start, part.end).join('')
  }
  const protections = (plan.protectedRanges ?? []).filter(part => overlap(part, range)).map(part => {
    const intersection = { start: Math.max(part.start, range.start), end: Math.min(part.end, range.end) }
    return { start: intersection.start - range.start, end: intersection.end - range.start, text: slice(intersection) }
  })
  return { sourceVersion: source.version, sourceSha256, outputRange: range, outputSha256: await sha256(slice(range)), contextRef,
    contextSha256: await sha256(JSON.stringify(contextRef.contextRanges.map(slice))),
    rulesSha256: await sha256(JSON.stringify(selectedRules(preparation, contextRef, range, supplements, promptVersion, mode))),
    protectionSha256: await sha256(JSON.stringify(protections)) }
}
/** A semantic approval is necessary, and every mechanical dependency is checked from actual data. */
export async function verifyDocumentReuse(input: VerifyDocumentReuseInput): Promise<DocumentReuseApproval> {
  const { unit, plan, contextRef, oldPreparation, newPreparation } = input, request = parseDocumentReuseRequest(input.request)
  const chunk = unit.chunkRevisions.find(item => item.id === request.revisionId)
  const oldPlan = unit.plans.find(item => sameVersionReference(item, request.planRef)), item = plan.items.find(item => item.chunkId === request.chunkId)
  const oldItem = oldPlan?.items.find(item => item.chunkId === chunk?.chunkId)
  const oldSource = unit.sourceVersions.find(source => source.version === request.sourceVersion), source = unit.sourceVersions.find(source => source.version === plan.sourceVersion)
  if (!chunk || chunk.deletion || !oldPlan || !oldItem || !item || !oldSource || !source || chunk.status !== 'completed' || chunk.completeResult === false || chunk.sourceVersion !== request.sourceVersion ||
    chunk.kind === 'manual' || chunk.kind === 'machine' && !chunk.callRecord || !sameVersionReference(chunk.planRef, request.planRef) ||
    !sameVersionReference(chunk.preparationRef, oldPreparation) || plan.sourceVersion !== unit.sourceVersion || request.sourceVersion >= plan.sourceVersion ||
    oldItem.mode !== item.mode || !newPreparation.preparationReady || !same(mappedRange(oldItem.outputRange, request.sourceVersion, plan.sourceVersion, unit.corrections ?? []), item.outputRange)) throw new TypeError('Document reuse requires a complete original revision and exact surviving output range')
  const oldContext = chunk.callRecord?.contextRef ?? { preparationRef: chunk.preparationRef, termRefs: [], referenceRefs: [], contextRanges: [], supplementRefs: [] }
  // Matching output text does not excuse changed actual understanding context.
  if (!same(oldContext.contextRanges.map(range => mappedRange(range, request.sourceVersion, plan.sourceVersion, unit.corrections ?? [])), contextRef.contextRanges)) throw new TypeError('Document reuse actual context ranges changed')
  const previous = await dependencyEvidence(oldSource, input.oldSourceText, oldPreparation, oldPlan, oldItem.outputRange, oldContext,
    input.oldSupplements ?? [], chunk.callRecord?.promptVersion ?? null, oldItem.mode)
  const current = await dependencyEvidence(source, input.newSourceText, newPreparation, plan, item.outputRange, contextRef,
    input.newSupplements ?? [], item.mode === 'translate' ? DOCUMENT_TRANSLATION_PROMPT_VERSION : null, item.mode)
  return parseDocumentReuseApproval({ id: input.id, operationId: input.operationId, createdAt: input.createdAt, chunkId: item.chunkId,
    sourceVersion: plan.sourceVersion, planRef: { id: plan.id, version: plan.version }, preparationRef: { id: newPreparation.id, version: newPreparation.version },
    reuseRef: { sourceVersion: chunk.sourceVersion, planVersion: oldPlan.version, revisionId: chunk.id }, basis: request.basis, evidence: { previous, current } })
}
/** Saved evidence binds original facts to one approved new plan. It never rewrites an old call. */
export function validateDocumentReuseApproval(unit: DocumentUnit, supplied: DocumentReuseApproval): DocumentReuseApproval {
  const approval = parseDocumentReuseApproval(supplied), chunk = unit.chunkRevisions.find(item => item.id === approval.reuseRef.revisionId)
  const plan = unit.plans.find(item => sameVersionReference(item, approval.planRef)), oldPlan = unit.plans.find(item => chunk && sameVersionReference(item, chunk.planRef))
  const item = plan?.items.find(item => item.chunkId === approval.chunkId), oldItem = oldPlan?.items.find(item => item.chunkId === chunk?.chunkId)
  const { previous, current } = approval.evidence
  const sourceMatches = (evidence: DocumentReuseDependencyEvidence): boolean => {
    const source = unit.sourceVersions.find(source => source.version === evidence.sourceVersion)
    return !!source && (source.body.kind !== 'asset' || source.body.reference.sha256 === evidence.sourceSha256)
  }
  const approvedTasks = unit.tasks.filter(task => task.sourceVersion === approval.sourceVersion && task.operationId === approval.operationId &&
    (sameVersionReference(task.planRef, approval.planRef) && sameVersionReference(task.preparationRef, approval.preparationRef) ||
      task.executionFacts?.controls.some(control => control.planRef && control.preparationRef && sameVersionReference(control.planRef, approval.planRef) && sameVersionReference(control.preparationRef, approval.preparationRef)) ||
      task.executionFacts?.baseline.contextBindings.some(binding => binding.chunkId === approval.chunkId && same(binding.contextRef, current.contextRef))))
  const actualCurrentContexts = approvedTasks.flatMap(task => [
    ...(task.executionFacts?.baseline.contextBindings ?? []), ...(task.executionFacts?.blocks.flatMap(block => block.request.contextRef ? [{ chunkId: block.request.chunkId, contextRef: block.request.contextRef }] : []) ?? []),
    ...(task.executionFacts?.controls.flatMap(control => control.baseline?.contextBindings ?? []) ?? [])])
  if (!chunk || chunk.status !== 'completed' || chunk.kind === 'manual' || !plan || !oldPlan || !item || !oldItem || item.mode !== oldItem.mode || chunk.sourceVersion !== approval.reuseRef.sourceVersion ||
    oldPlan.version !== approval.reuseRef.planVersion || plan.sourceVersion !== approval.sourceVersion || !sameVersionReference(plan.preparationRef, approval.preparationRef) ||
    !sameVersionReference(previous.contextRef.preparationRef, chunk.preparationRef) || !sameVersionReference(current.contextRef.preparationRef, approval.preparationRef) ||
    chunk.callRecord && !same(previous.contextRef, chunk.callRecord.contextRef) || !sourceMatches(previous) || !sourceMatches(current) ||
    chunk.content.kind === 'source_copy' && chunk.content.sha256 !== previous.outputSha256 ||
    !same(previous.outputRange, oldItem.outputRange) || !same(current.outputRange, item.outputRange) ||
    !same(mappedRange(oldItem.outputRange, chunk.sourceVersion, plan.sourceVersion, unit.corrections ?? []), item.outputRange) ||
    !same(previous.contextRef.contextRanges.map(range => mappedRange(range, chunk.sourceVersion, plan.sourceVersion, unit.corrections ?? [])), current.contextRef.contextRanges) ||
    !actualCurrentContexts.some(binding => binding.chunkId === item.chunkId && same(binding.contextRef, current.contextRef))) throw new TypeError('Document reuse approval does not match immutable source, plan and actual context facts')
  return approval
}
/** Later dependency updates preserve this completed fact; eligibility separately records mixed dependencies. */
export function isDocumentManifestReuse(unit: DocumentUnit, revision: Pick<DocumentRevision, 'taskId' | 'sourceVersion' | 'planRef' | 'preparationRef'>, entry: ManifestEntry): boolean {
  if (unit.chunkRevisions.find(chunk => chunk.id === entry.revisionId)?.deletion) return false
  if (!entry.reuseRef?.approvalId) return false
  const approval = unit.reuseApprovals?.find(item => item.id === entry.reuseRef!.approvalId)
  if (!approval) return false
  try { validateDocumentReuseApproval(unit, approval) } catch { return false }
  const plan = unit.plans.find(plan => sameVersionReference(plan, revision.planRef)), item = plan?.items.find(item => item.chunkId === entry.chunkId)
  const approvedItem = unit.plans.find(plan => sameVersionReference(plan, approval.planRef))?.items.find(item => item.chunkId === approval.chunkId)
  return unit.tasks.find(task => task.taskId === revision.taskId)?.operationId === approval.operationId &&
    approval.sourceVersion === revision.sourceVersion && plan?.sourceVersion === revision.sourceVersion && !!item && item.mode === approvedItem?.mode &&
    sameVersionReference(plan.preparationRef, revision.preparationRef) && same(item.outputRange, entry.outputRange) && approval.chunkId === entry.chunkId &&
    same(approval.evidence.current.outputRange, entry.outputRange) && approval.reuseRef.sourceVersion === entry.reuseRef.sourceVersion &&
    approval.reuseRef.planVersion === entry.reuseRef.planVersion && approval.reuseRef.revisionId === entry.reuseRef.revisionId && entry.revisionId === approval.reuseRef.revisionId
}
export function validateDocumentCorrectionFact(unit: DocumentUnit, supplied: DocumentCorrectionFact): DocumentCorrectionFact {
  const fact = parseDocumentCorrectionFact(supplied), previous = unit.sourceVersions.find(source => source.version === fact.fromSourceVersion), source = unit.sourceVersions.find(source => source.version === fact.toSourceVersion)
  if (!previous || !source || documentSourceLength(previous) !== fact.oldLength || documentSourceLength(source) !== fact.newLength ||
    source.operationId !== fact.operationId || source.createdAt !== fact.createdAt) throw new TypeError('Document correction mapping does not match its immutable source versions')
  return fact
}
