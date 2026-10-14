import { documentSourceLength, parseChunkRevision, parseDocumentChunkPlan, parseDocumentPreparationReference,
  parseDocumentRevision, parseDocumentSourceVersion, parseDocumentTaskRecord, parseDocumentUnitShape, sameVersionReference,
  type ChunkRevision, type DocumentChunkPlan, type DocumentEligibility, type DocumentPreparationReference,
  type DocumentRevision, type DocumentSourceVersion, type DocumentTaskRecord, type DocumentUnit,
  type VersionReference } from '../shared/translation-batch.js'
import { isDocumentManifestReuse, validateDocumentCorrectionFact, validateDocumentReuseApproval } from './document-correction.js'
import { parseDocumentCorrectionFact, type DocumentCorrectionFact, type DocumentReuseApproval } from '../shared/document-correction.js'

export type NewDocumentUnit = Pick<DocumentUnit, 'id' | 'targetLanguage' | 'instruction' | 'createdAt'> & {
  readonly source: DocumentSourceVersion
  readonly preparation: DocumentPreparationReference
  readonly plan: DocumentChunkPlan
  readonly task: DocumentTaskRecord
}
export type DocumentMutation =
  | { readonly kind: 'source'; readonly expectedVersion: number; readonly source: DocumentSourceVersion }
  | { readonly kind: 'correction'; readonly expectedVersion: number; readonly source: DocumentSourceVersion; readonly fact: DocumentCorrectionFact }
  | { readonly kind: 'reuse'; readonly approval: DocumentReuseApproval }
  | { readonly kind: 'preparation'; readonly preparation: DocumentPreparationReference }
  | { readonly kind: 'plan'; readonly plan: DocumentChunkPlan }
  | { readonly kind: 'task'; readonly task: DocumentTaskRecord }
  | { readonly kind: 'task_update'; readonly taskId: string; readonly status: DocumentTaskRecord['status'] }
  | { readonly kind: 'task_facts'; readonly taskId: string; readonly facts: NonNullable<DocumentTaskRecord['executionFacts']>; readonly status?: DocumentTaskRecord['status']; readonly planRef?: VersionReference; readonly preparationRef?: VersionReference }
  | { readonly kind: 'chunk'; readonly revision: ChunkRevision; readonly executionFacts?: NonNullable<DocumentTaskRecord['executionFacts']> }
  | { readonly kind: 'chunk_update'; readonly revisionId: string; readonly patch: Partial<Pick<ChunkRevision, 'status' | 'content' | 'callRecord' | 'updatedAt'>>; readonly executionFacts?: NonNullable<DocumentTaskRecord['executionFacts']> }
  | { readonly kind: 'manifest'; readonly revision: Omit<DocumentRevision, 'eligibility'> }
  | { readonly kind: 'final'; readonly revisionId: string; readonly at: string }

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)
function at(value: string): void { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new TypeError('Invalid document transition time') }
function unique<T>(items: readonly T[], key: (item: T) => string): void {
  if (new Set(items.map(key)).size !== items.length) throw new TypeError('Duplicate document identity')
}
function versions(items: readonly VersionReference[]): void {
  const latest = new Map<string, number>()
  for (const item of items) {
    if (item.version <= (latest.get(item.id) ?? 0)) throw new TypeError('Document reference versions must increase')
    latest.set(item.id, item.version)
  }
}
function sourceOf(unit: DocumentUnit, sourceVersion: number): DocumentSourceVersion {
  const source = unit.sourceVersions.find(item => item.version === sourceVersion)
  if (!source) throw new TypeError('Document source version unavailable')
  return source
}
function planOf(unit: DocumentUnit, reference: VersionReference): DocumentChunkPlan {
  const plan = unit.plans.find(item => sameVersionReference(item, reference))
  if (!plan) throw new TypeError('Fixed document plan unavailable')
  return plan
}
function binding(unit: DocumentUnit, value: Pick<DocumentTaskRecord, 'sourceVersion' | 'planRef' | 'preparationRef'>): DocumentChunkPlan {
  const plan = planOf(unit, value.planRef)
  const preparation = unit.preparations.find(item => sameVersionReference(item, value.preparationRef))
  sourceOf(unit, value.sourceVersion)
  if (!preparation || preparation.sourceVersion !== value.sourceVersion || plan.sourceVersion !== value.sourceVersion ||
    !sameVersionReference(plan.preparationRef, value.preparationRef)) throw new TypeError('Document source, plan and preparation binding changed')
  return plan
}
function taskOf(unit: DocumentUnit, value: Pick<ChunkRevision, 'taskId' | 'sourceVersion' | 'planRef' | 'preparationRef'>): DocumentTaskRecord {
  const task = unit.tasks.find(item => item.taskId === value.taskId)
  const oldBinding = task?.executionFacts?.controls.some(control => control.planRef && control.preparationRef && sameVersionReference(control.planRef, value.planRef) && sameVersionReference(control.preparationRef, value.preparationRef))
  const initial = task?.executionFacts && unit.plans.find(plan => sameVersionReference(plan.preparationRef, task.executionFacts!.baseline.contextBindings[0]?.contextRef.preparationRef ?? task.preparationRef) && sameVersionReference(plan, value.planRef))
  if (!task || task.sourceVersion !== value.sourceVersion || !(sameVersionReference(task.planRef, value.planRef) && sameVersionReference(task.preparationRef, value.preparationRef) || oldBinding || initial)) throw new TypeError('Document result does not belong to its fixed task')
  return task
}
function validateChunk(unit: DocumentUnit, revision: ChunkRevision): void {
  taskOf(unit, revision)
  const plan = binding(unit, revision), item = plan.items.find(item => item.chunkId === revision.chunkId)
  if (!item || (revision.kind === 'copy' ? item.mode !== 'copy' : item.mode !== 'translate')) throw new TypeError('Document chunk does not belong to the fixed plan')
  if (revision.content.kind === 'source_copy' && (revision.content.sourceVersion !== revision.sourceVersion || !same(revision.content.range, item.outputRange))) throw new TypeError('Copy must reference the exact source output range')
  // Actual contexts include preparation background and exclude output overlap. Admission
  // checks their frozen budget; history retains their exact immutable references.
}
/** Invalid references are rejected; an ended but incomplete chunk remains a visible candidate. */
export function documentManifestEligibility(unit: DocumentUnit, revision: Omit<DocumentRevision, 'eligibility'>): DocumentEligibility {
  taskOf(unit, revision)
  const plan = binding(unit, revision)
  if (revision.entries.length !== plan.items.length) throw new TypeError('Document manifest must cover the fixed plan once')
  let complete = true, mixedDependencies = false
  const revisionIds = new Set<string>()
  for (let index = 0; index < plan.items.length; index++) {
    const item = plan.items[index]!, entry = revision.entries[index]!
    const chunk = unit.chunkRevisions.find(chunk => chunk.id === entry.revisionId)
    if (!chunk || revisionIds.has(entry.revisionId) || entry.chunkId !== item.chunkId ||
      !same(entry.outputRange, item.outputRange)) throw new TypeError('Document manifest reference or output range changed')
    revisionIds.add(entry.revisionId)
    if (entry.reuseRef) {
      if (!isDocumentManifestReuse(unit, revision, entry)) throw new TypeError('Document reuse requires verified source and preparation dependencies')
      const approval = unit.reuseApprovals!.find(approval => approval.id === entry.reuseRef!.approvalId)!
      if (!sameVersionReference(approval.planRef, revision.planRef) || !sameVersionReference(approval.preparationRef, revision.preparationRef)) mixedDependencies = true
      continue
    }
    if (chunk.chunkId !== item.chunkId) throw new TypeError('Document manifest chunk identity changed')
    if (chunk.taskId !== revision.taskId || chunk.sourceVersion !== revision.sourceVersion) throw new TypeError('Document manifest mixes source or task identities')
    if (!sameVersionReference(chunk.planRef, revision.planRef) || !sameVersionReference(chunk.preparationRef, revision.preparationRef)) mixedDependencies = true
    if (chunk.status !== 'completed') complete = false
  }
  return { complete, finalEligible: complete && !mixedDependencies && revision.review.status === 'passed' && revision.review.issues.length === 0 }
}

/** Strict saved-history boundary; no I/O, execution capability, or replay is reconstructed. */
export function parseDocumentUnit(value: unknown): DocumentUnit {
  const unit = parseDocumentUnitShape(value)
  unique(unit.tasks, item => item.taskId); unique(unit.tasks, item => item.operationId)
  unique([...unit.chunkRevisions, ...unit.revisions], item => item.id)
  unique(unit.chunkRevisions.filter(item => item.callId !== null), item => item.callId!)
  unique(unit.chunkRevisions.filter(item => item.attemptId !== null), item => item.attemptId!)
  unique(unit.sourceVersions.filter(item => item.operationId !== null), item => item.operationId!)
  unique(unit.plans, item => item.operationId)
  unique([...unit.sourceVersions.filter(item => item.operationId !== null).map(item => item.operationId!),
    ...unit.plans.map(item => item.operationId), ...unit.tasks.map(item => item.operationId), ...unit.tasks.flatMap(task => task.executionFacts?.controls.map(control => control.operationId) ?? [])], item => item)
  versions(unit.preparations); versions(unit.plans)
  if (!unit.tasks.length) throw new TypeError('Document units require a real admitted task')
  const assets = new Map<string, unknown>()
  for (const source of unit.sourceVersions) {
    if (source.version > 1 && source.operationId === null) throw new TypeError('Document corrections require their operation identity')
    if (source.body.kind !== 'asset') continue
    const prior = assets.get(source.body.reference.sourceId)
    if (prior && !same(prior, source.body.reference)) throw new TypeError('Immutable source asset metadata changed')
    assets.set(source.body.reference.sourceId, source.body.reference)
  }
  for (const preparation of unit.preparations) sourceOf(unit, preparation.sourceVersion)
  for (const plan of unit.plans) binding(unit, { sourceVersion: plan.sourceVersion, planRef: plan, preparationRef: plan.preparationRef })
  for (const task of unit.tasks) binding(unit, task)
  unique(unit.corrections ?? [], fact => fact.operationId)
  unique(unit.corrections ?? [], fact => String(fact.toSourceVersion))
  unique(unit.reuseApprovals ?? [], approval => approval.id)
  for (const fact of unit.corrections ?? []) validateDocumentCorrectionFact(unit, fact)
  for (const approval of unit.reuseApprovals ?? []) validateDocumentReuseApproval(unit, approval)
  for (const task of unit.tasks) if (task.executionFacts) {
    const facts = task.executionFacts
    for (const block of facts.blocks) {
      const request = block.request, chunk = unit.chunkRevisions.find(chunk => chunk.id === request.revisionId)
      if (request.taskId !== task.taskId || request.unitId !== unit.id || request.scope.translationSessionId === '' || request.scope.ownerId !== request.scope.mainSessionId ||
        chunk && (chunk.childOperationId !== request.childOperationId || chunk.chunkId !== request.chunkId || chunk.callId !== request.callId || chunk.attemptId !== request.attemptId)) throw new TypeError('Saved block registration disagrees with actual chunk facts')
      if (block.phase === 'dispatched' && !chunk?.callRecord || block.phase === 'settled' && chunk && !['completed', 'failed', 'cancelled', 'unknown', 'interrupted'].includes(chunk.status)) throw new TypeError('Saved block phase lacks actual result facts')
    }
    if (facts.actualCalls !== facts.baseline.analysisActualCalls + unit.chunkRevisions.filter(chunk => chunk.taskId === task.taskId && chunk.callRecord).length) throw new TypeError('Actual call count disagrees with saved calls')
  }
  for (const chunk of unit.chunkRevisions) validateChunk(unit, chunk)
  const children = new Map<string, ChunkRevision>()
  for (const chunk of unit.chunkRevisions) {
    const old = children.get(chunk.childOperationId)
    if (old && (old.taskId !== chunk.taskId || old.chunkId !== chunk.chunkId || old.sourceVersion !== chunk.sourceVersion ||
      !sameVersionReference(old.planRef, chunk.planRef) || !sameVersionReference(old.preparationRef, chunk.preparationRef))) throw new TypeError('Child operation belongs to another document chunk')
    children.set(chunk.childOperationId, chunk)
    if (unit.tasks.some(task => task.operationId === chunk.childOperationId) || unit.plans.some(plan => plan.operationId === chunk.childOperationId) ||
      unit.sourceVersions.some(source => source.operationId === chunk.childOperationId)) throw new TypeError('Child operation collides with a parent operation')
  }
  for (const revision of unit.revisions) if (!same(revision.eligibility, documentManifestEligibility(unit, revision))) throw new TypeError('Stored document qualification does not match its facts')
  for (const task of unit.tasks) if (task.status === 'completed' && !unit.revisions.some(revision => revision.taskId === task.taskId && revision.eligibility.complete)) throw new TypeError('Completed document task lacks a complete manifest')
  if (unit.final && !unit.revisions.some(revision => revision.id === unit.final!.revisionId && revision.eligibility.finalEligible)) throw new TypeError('Document final does not reference an eligible manifest')
  return unit
}

export function createDocumentUnit(data: NewDocumentUnit, order: number): DocumentUnit {
  if (data.source.version !== 1 || data.task.sourceVersion !== 1 || data.task.status !== 'running') throw new TypeError('New document unit requires its first admitted task')
  return parseDocumentUnit({ kind: 'document', id: data.id, order, targetLanguage: data.targetLanguage, instruction: data.instruction,
    sourceVersion: 1, sourceVersions: [data.source], createdAt: data.createdAt, preparations: [data.preparation], plans: [data.plan],
    tasks: [data.task], chunkRevisions: [], revisions: [], final: null })
}
function appendVersion<T extends VersionReference>(items: readonly T[], added: T): readonly T[] {
  const old = items.find(item => sameVersionReference(item, added))
  if (old) {
    if (same(old, added)) return items
    throw new TypeError('Document reference already has different content')
  }
  if (added.version <= (items.filter(item => item.id === added.id).at(-1)?.version ?? 0)) throw new TypeError('Stale document reference version')
  return [...items, added]
}
/** Admission and receipts mutate one unit. Late old-source receipts never select a current final. */
export function reduceDocumentUnit(unit: DocumentUnit, mutation: DocumentMutation): DocumentUnit {
  let next: DocumentUnit
  if (mutation.kind === 'correction') {
    const source = parseDocumentSourceVersion(mutation.source), fact = parseDocumentCorrectionFact(mutation.fact)
    const old = unit.corrections?.find(item => item.operationId === fact.operationId)
    if (old) {
      const prior = unit.sourceVersions.find(item => item.version === fact.toSourceVersion)
      const { historyCommit: _newCommit, ...newSource } = source, { historyCommit: _oldCommit, ...oldSource } = prior!
      if (same(old, fact) && same(oldSource, newSource) && mutation.expectedVersion === fact.fromSourceVersion) return unit
      throw new TypeError('Document correction operation already has different content')
    }
    if (fact.fromSourceVersion !== mutation.expectedVersion || source.version !== fact.toSourceVersion || source.operationId !== fact.operationId || source.createdAt !== fact.createdAt) throw new TypeError('Document correction identity changed')
    next = reduceDocumentUnit(unit, { kind: 'source', expectedVersion: mutation.expectedVersion, source })
    next = { ...next, corrections: [...(unit.corrections ?? []), fact] }
  } else if (mutation.kind === 'reuse') {
    const approval = validateDocumentReuseApproval(unit, mutation.approval), old = unit.reuseApprovals?.find(item => item.id === approval.id)
    if (old) { if (same(old, approval)) return unit; throw new TypeError('Document reuse approval already has different content') }
    next = { ...unit, reuseApprovals: [...(unit.reuseApprovals ?? []), approval] }
  } else if (mutation.kind === 'source') {
    const source = parseDocumentSourceVersion(mutation.source), old = unit.sourceVersions.find(item => item.operationId === source.operationId)
    if (!source.operationId) throw new TypeError('Document source correction needs its operation identity')
    if (old) {
      const { historyCommit: _oldCommit, ...oldFact } = old, { historyCommit: _newCommit, ...newFact } = source
      if (same(oldFact, newFact) && source.version === mutation.expectedVersion + 1) return unit
      throw new TypeError('Source correction operation already has different content')
    }
    if (unit.sourceVersion !== mutation.expectedVersion || source.version !== mutation.expectedVersion + 1 || same(source.body, sourceOf(unit, unit.sourceVersion).body)) throw new TypeError('Invalid or stale document source correction')
    next = { ...unit, sourceVersion: source.version, sourceVersions: [...unit.sourceVersions, source] }
  } else if (mutation.kind === 'preparation') {
    const preparation = parseDocumentPreparationReference(mutation.preparation), preparations = appendVersion(unit.preparations, preparation)
    if (preparations === unit.preparations) return unit
    if (preparation.sourceVersion !== unit.sourceVersion) throw new TypeError('New preparation must bind the current source')
    next = { ...unit, preparations }
  } else if (mutation.kind === 'plan') {
    const plan = parseDocumentChunkPlan(mutation.plan, documentSourceLength(sourceOf(unit, mutation.plan.sourceVersion))), plans = appendVersion(unit.plans, plan)
    if (plans === unit.plans) return unit
    if (plan.sourceVersion !== unit.sourceVersion) throw new TypeError('New plan must bind the current source')
    next = { ...unit, plans }
  } else if (mutation.kind === 'task') {
    const task = parseDocumentTaskRecord(mutation.task), old = unit.tasks.find(item => item.taskId === task.taskId || item.operationId === task.operationId)
    if (old) { if (task.status === 'running' && same({ ...old, status: 'running' }, task)) return unit; throw new TypeError('Document admission already has different content') }
    if (task.sourceVersion !== unit.sourceVersion || task.status !== 'running') throw new TypeError('New task requires current fixed material')
    next = { ...unit, tasks: [...unit.tasks, task] }
  } else if (mutation.kind === 'task_update') {
    const old = unit.tasks.find(task => task.taskId === mutation.taskId)
    if (!old) throw new TypeError('Document task unavailable')
    if (old.status === mutation.status) return unit
    if (!['running', 'paused', 'waiting_context', 'waiting_user', 'unknown'].includes(old.status)) throw new TypeError('Ended document tasks are immutable')
    if (mutation.status === 'completed' && !unit.revisions.some(revision => revision.taskId === old.taskId && revision.eligibility.complete)) throw new TypeError('Completed document task lacks a complete manifest')
    next = { ...unit, tasks: unit.tasks.map(task => task.taskId === old.taskId ? { ...task, status: mutation.status } : task) }
  } else if (mutation.kind === 'task_facts') {
    const old = unit.tasks.find(task => task.taskId === mutation.taskId)
    if (!old?.executionFacts) throw new TypeError('Document execution baseline unavailable')
    const facts = mutation.facts
    if (!same(old.executionFacts.baseline, facts.baseline) || facts.taskSequence < old.executionFacts.taskSequence || facts.taskVersion < old.executionFacts.taskVersion ||
      facts.actualCalls < old.executionFacts.actualCalls || facts.outputBytes < old.executionFacts.outputBytes || facts.automaticSupplementCalls < old.executionFacts.automaticSupplementCalls ||
      old.executionFacts.supplements?.some((supplement, index) => !same(supplement, facts.supplements?.[index])) ||
      old.executionFacts.controls.some((control, index) => !same(control, facts.controls[index])) || old.executionFacts.blocks.some(block => {
        const next = facts.blocks.find(item => item.request.revisionId === block.request.revisionId)
        return !next || !same(block.request, next.request) || next.sequence < block.sequence || block.phase === 'settled' && next.phase !== 'settled'
      })) throw new TypeError('Saved execution facts cannot be rewritten')
    next = { ...unit, tasks: unit.tasks.map(task => task.taskId === old.taskId ? { ...task, executionFacts: facts, status: mutation.status ?? task.status,
      planRef: mutation.planRef ?? task.planRef, preparationRef: mutation.preparationRef ?? task.preparationRef } : task) }
  } else if (mutation.kind === 'chunk') {
    const revision = parseChunkRevision(mutation.revision, documentSourceLength(sourceOf(unit, mutation.revision.sourceVersion)))
    const old = unit.chunkRevisions.find(item => item.id === revision.id)
    if (old) { if (same(old, revision)) return unit; throw new TypeError('Document chunk already has different content') }
    next = { ...unit, chunkRevisions: [...unit.chunkRevisions, revision] }
  } else if (mutation.kind === 'chunk_update') {
    const old = unit.chunkRevisions.find(item => item.id === mutation.revisionId)
    if (!old) throw new TypeError('Document chunk revision unavailable')
    if (Object.keys(mutation.patch).some(key => !['status', 'content', 'callRecord', 'updatedAt'].includes(key))) throw new TypeError('Document chunk identity is immutable')
    const revision = parseChunkRevision({ ...old, ...mutation.patch }, documentSourceLength(sourceOf(unit, old.sourceVersion)))
    if (same(old, revision)) return unit
    if (old.callRecord) {
      if (!revision.callRecord) throw new TypeError('Actual document call cannot be removed')
      const { usage: oldUsage, ...oldCall } = old.callRecord, { usage: newUsage, ...newCall } = revision.callRecord
      if (!same(oldCall, newCall) || (['inputTokens', 'outputTokens'] as const).some(key => oldUsage[key] !== null && oldUsage[key] !== newUsage[key])) throw new TypeError('Actual document call facts are immutable')
    }
    if (!['running', 'unknown'].includes(old.status)) throw new TypeError('Ended document chunks are immutable')
    if (unit.revisions.some(manifest => manifest.entries.some(entry => entry.revisionId === old.id))) throw new TypeError('A fixed manifest chunk is immutable')
    next = { ...unit, chunkRevisions: unit.chunkRevisions.map(item => item.id === revision.id ? revision : item) }
  } else if (mutation.kind === 'manifest') {
    const revision = parseDocumentRevision({ ...mutation.revision, eligibility: documentManifestEligibility(unit, mutation.revision) },
      documentSourceLength(sourceOf(unit, mutation.revision.sourceVersion)))
    const old = unit.revisions.find(item => item.id === revision.id)
    if (old) { if (same(old, revision)) return unit; throw new TypeError('Document manifest already has different content') }
    next = { ...unit, revisions: [...unit.revisions, revision] }
  } else return selectDocumentFinal(unit, mutation.revisionId, mutation.at)
  if ((mutation.kind === 'chunk' || mutation.kind === 'chunk_update') && mutation.executionFacts) {
    const taskId = mutation.kind === 'chunk' ? mutation.revision.taskId : unit.chunkRevisions.find(chunk => chunk.id === mutation.revisionId)!.taskId
    const old = unit.tasks.find(task => task.taskId === taskId)!, facts = mutation.executionFacts
    if (!old.executionFacts || !same(old.executionFacts.baseline, facts.baseline) || facts.taskVersion !== old.executionFacts.taskVersion || facts.taskSequence < old.executionFacts.taskSequence) throw new TypeError('Chunk execution facts changed baseline or control version')
    next = { ...next, tasks: next.tasks.map(task => task.taskId === taskId ? { ...task, executionFacts: facts } : task) }
  }
  return parseDocumentUnit(next)
}
export function currentDocumentFinal(unit: DocumentUnit): DocumentRevision | undefined {
  return unit.revisions.find(revision => revision.id === unit.final?.revisionId && revision.sourceVersion === unit.sourceVersion && revision.eligibility.finalEligible)
}
export function advanceDocumentFinal(unit: DocumentUnit, selectedAt: string): DocumentUnit {
  at(selectedAt)
  if (unit.final?.selection === 'user_fixed' && currentDocumentFinal(unit)) return unit
  const latest = [...unit.revisions].reverse().find(revision => revision.sourceVersion === unit.sourceVersion)
  if (!latest?.eligibility.finalEligible || latest.id === unit.final?.revisionId || unit.tasks.find(task => task.taskId === latest.taskId)?.executionFacts?.reviewIssues.length) return unit
  return { ...unit, final: { revisionId: latest.id, selection: 'automatic', selectedAt } }
}
export function selectDocumentFinal(unit: DocumentUnit, revisionId: string, selectedAt: string): DocumentUnit {
  at(selectedAt)
  const revision = unit.revisions.find(item => item.id === revisionId)
  if (!revision || revision.sourceVersion !== unit.sourceVersion || !revision.eligibility.finalEligible || unit.tasks.find(task => task.taskId === revision.taskId)?.executionFacts?.reviewIssues.length) throw new TypeError('Only an eligible current-source manifest can be final')
  if (unit.final?.selection === 'user_fixed' && unit.final.revisionId === revisionId) return unit
  return { ...unit, final: { revisionId, selection: 'user_fixed', selectedAt } }
}
export function restoreDocumentUnit(unit: DocumentUnit): DocumentUnit {
  const interrupted = (status: DocumentTaskRecord['status']): boolean => ['running', 'paused', 'waiting_context', 'waiting_user', 'unknown'].includes(status)
  const tasks = unit.tasks.map(task => interrupted(task.status) ? { ...task, status: 'interrupted' as const } : task)
  const chunkRevisions = unit.chunkRevisions.map(chunk => interrupted(chunk.status) ? { ...chunk, status: 'interrupted' as const } : chunk)
  if (tasks.every((task, index) => task === unit.tasks[index]) && chunkRevisions.every((chunk, index) => chunk === unit.chunkRevisions[index])) return unit
  return parseDocumentUnit({ ...unit, tasks, chunkRevisions })
}
