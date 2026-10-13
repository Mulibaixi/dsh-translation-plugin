import {
  MAX_PREPARATION_PACKET_BYTES, MAX_PREPARATION_PAGE_BYTES, MAX_PREPARATION_PAGE_ITEMS,
  parsePreparationAnalysisFacts, parsePreparationCurrentFacts, parsePreparationSnapshot, parseTranslationPreparationPrepare,
  parseTranslationPreparationSet, parseTranslationPreparationQuery, parseTranslationPreparationRead,
  preparationPacketBytes, type AnalysisResult, type AnalysisCandidate, type PreparationAnalysisFacts,
  type PreparationCurrentFacts, type PreparationPrepareFacts, type PreparationCandidate,
  type PreparationFrozenTerm, type PreparationConflict, type PreparationSnapshot, type PreparationReceipt,
  type PreparationPage, type PreparationTermRef, type TranslationPreparationPrepare,
  type TranslationPreparationSet, type TranslationPreparationQuery, type TranslationPreparationRead,
} from '../shared/translation-preparation.js'
import { sourceCodePointLength, type TranslationSourceRange } from '../shared/translation-source-read.js'
import type { TranslationSourceScope } from '../shared/translation-sources.js'
import type { TranslationMaterialEnvelope } from '../shared/translation-material.js'
import type { TopicTermSnapshot, TopicTerm } from '../memory/topic-terms.js'

export const PREPARATION_STORAGE_PREFIX = 'dsh-translation-plugin:preparation:v1:'
export interface PreparationStoragePort {
  keys(): readonly string[]
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}
export interface PreparationStoreOptions {
  readonly storage?: PreparationStoragePort
  readonly withLock?: <T>(action: () => T | Promise<T>) => Promise<T>
  readonly isEnabled?: () => boolean
  readonly isScopeCurrent?: (scope: TranslationSourceScope) => boolean
  readonly isTopicTermsCurrent?: (snapshot: TopicTermSnapshot) => boolean
}
interface Operation { readonly signature: string; readonly version: number }
interface StoredPreparation {
  readonly schemaVersion: 1
  readonly cursorToken: string
  readonly prepareSignature: string
  readonly candidateCount: number
  readonly versions: readonly PreparationSnapshot[]
  readonly operations: Readonly<Record<string, Operation>>
}
interface Catalog {
  readonly analysis: PreparationAnalysisFacts
  readonly candidates: readonly PreparationCandidate[]
  readonly binding: string
}
interface Seat { stored: string | null; audit: StoredPreparation; catalog?: Catalog; planningBindings?: Readonly<Record<number, Readonly<Record<string, number>>>> }
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)
const now = (): string => new Date().toISOString()
function immutable<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) immutable(child)
    Object.freeze(value)
  }
  return value
}
function ok<T>(value: T): AnalysisResult<T> { return { ok: true, value: immutable(value) } }
function bad<T>(code: string, message: string, stage = 'preparation'): AnalysisResult<T> { return { ok: false, error: { code, message, stage } } }
function reject(code: string, message: string): never { throw Object.assign(new Error(message), { code }) }
function key(ownerId: string, id: string): string { return `${PREPARATION_STORAGE_PREFIX}${encodeURIComponent(ownerId)}:${encodeURIComponent(id)}` }
function materialScope(envelope: Extract<TranslationMaterialEnvelope, { kind: 'material' }>): TranslationSourceScope {
  return { ownerId: envelope.ownerId, mainSessionId: envelope.mainSessionId, topicId: envelope.material.topicId, translationSessionId: envelope.material.translationSessionId }
}
function matchesTarget(envelope: Extract<TranslationMaterialEnvelope, { kind: 'material' }>, target: TranslationPreparationQuery['target']): boolean {
  return envelope.mainSessionId === target.mainSessionId && envelope.requestId === target.requestId && envelope.material.materialId === target.materialId && envelope.material.sourceVersion === target.sourceVersion
}
function binding(envelope: Extract<TranslationMaterialEnvelope, { kind: 'material' }>, hash: string): string {
  const { sourceText: _text, ...material } = envelope.material
  return JSON.stringify({ ...envelope, material, sourceSha256: hash })
}
async function sourceHash(envelope: Extract<TranslationMaterialEnvelope, { kind: 'material' }>): Promise<string> {
  if (envelope.material.sourceRef) return envelope.material.sourceRef.sha256
  return await textHash(envelope.material.sourceText!)
}
async function textHash(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
function validRanges(items: readonly TranslationSourceRange[], total: number): boolean {
  return items.every((item, index) => Number.isSafeInteger(item.start) && Number.isSafeInteger(item.end) && item.start >= 0 && item.end > item.start && item.end <= total && (index === 0 || item.start >= items[index - 1]!.end))
}
function requiredRanges(excluded: readonly TranslationSourceRange[], total: number): readonly TranslationSourceRange[] {
  const result: TranslationSourceRange[] = []; let start = 0
  for (const item of excluded) { if (item.start > start) result.push({ start, end: item.start }); start = item.end }
  if (start < total) result.push({ start, end: total })
  return result
}
function covers(actual: readonly TranslationSourceRange[], required: readonly TranslationSourceRange[]): boolean {
  const sorted = [...actual].sort((a, b) => a.start - b.start || a.end - b.end)
  return required.every(requiredRange => {
    let end = requiredRange.start
    for (const item of sorted) {
      if (item.end <= end) continue
      if (item.start > end) break
      end = item.end
      if (end >= requiredRange.end) return true
    }
    return false
  })
}
function overlaps(left: readonly TranslationSourceRange[], right: readonly TranslationSourceRange[]): boolean { return left.some(a => right.some(b => a.start < b.end && b.start < a.end)) }
function applicableRanges(items: readonly TranslationSourceRange[], required: readonly TranslationSourceRange[]): boolean {
  return items.every(item => covers(required, [item]))
}
function sharedForms(left: PreparationFrozenTerm, right: PreparationFrozenTerm): readonly string[] {
  return [...left.sourceForms, ...left.aliases].filter(form => [...right.sourceForms, ...right.aliases].includes(form))
}
function fixed(entry: TopicTerm): boolean {
  return entry.origin === 'user_explicit' && entry.confirmation !== null && entry.confirmation.adoptedEntryVersion < entry.version
}
function fixedBinding(snapshot: TopicTermSnapshot, targetLanguage: string): Readonly<Record<string, number>> {
  return Object.fromEntries(snapshot.entries.filter(entry => entry.status === 'active' && entry.targetLanguage === targetLanguage && fixed(entry)).map(entry => [entry.id, entry.version]))
}
function analysisBusinessFacts(analysis: PreparationAnalysisFacts): unknown {
  const { notification: _notification, updatedAt: _updatedAt, ...run } = analysis.run
  return { ...analysis, run }
}
/** Exact pairs only. Description alternatives and original spellings remain observable. */
export function mergePreparationCandidates(candidates: readonly AnalysisCandidate[]): readonly PreparationCandidate[] {
  const pairs = new Map<string, AnalysisCandidate[]>()
  for (const candidate of candidates) {
    const pair = JSON.stringify([candidate.original, candidate.suggestedTranslation]), old = pairs.get(pair)
    if (old) old.push(candidate); else pairs.set(pair, [candidate])
  }
  return immutable([...pairs.values()].map(members => {
    const first = members[0]!, descriptions = new Map<string, { id: string; version: 1 }[]>(), occurrences = new Map<string, TranslationSourceRange>(), countsByCall = new Map<string, number>()
    for (const member of members) {
      const description = member.description ?? '', list = descriptions.get(description), ref = { id: member.id, version: 1 as const }
      if (list) list.push(ref); else descriptions.set(description, [ref])
      for (const occurrence of member.occurrences) occurrences.set(JSON.stringify(occurrence), occurrence)
      countsByCall.set(member.callId, Math.max(countsByCall.get(member.callId) ?? 0, member.occurrenceCount))
    }
    return { id: first.id, version: 1 as const, original: first.original, preferred: first.suggestedTranslation,
      members: members.map(member => ({ id: member.id, version: 1 as const, callId: member.callId })),
      descriptions: [...descriptions].map(([description, candidateRefs]) => ({ description, candidateRefs })),
      occurrences: [...occurrences.values()].sort((a, b) => a.start - b.start || a.end - b.end),
      occurrenceCount: [...countsByCall.values()].reduce((sum, count) => sum + count, 0), occurrenceSamples: 'bounded_analysis_samples' as const, origin: 'model_inferred' as const }
  }))
}

/** Client authority for task preparation. It never mutates permanent topic assets or dispatches a model. */
export class PreparationStore {
  private readonly seats = new Map<string, Seat>()
  private disposed = false
  constructor(private readonly options: PreparationStoreOptions = {}) {
    try {
      for (const storageKey of options.storage?.keys() ?? []) {
        if (!storageKey.startsWith(PREPARATION_STORAGE_PREFIX)) continue
        try {
          const raw = options.storage!.getItem(storageKey)
          if (raw === null) continue
          const audit = this.decode(raw), first = audit.versions[0]!
          if (storageKey !== key(first.scope.ownerId, first.id)) continue
          this.seats.set(storageKey, { stored: raw, audit })
        } catch { /* Preserve an invalid audit without hiding independent valid records. */ }
      }
    } catch { /* An unreadable audit is preserved in storage and cannot be edited. */ }
  }
  dispose(): void { this.disposed = true; this.seats.clear() }
  private locked<T>(action: () => T | Promise<T>): Promise<T> { return this.options.withLock ? this.options.withLock(action) : Promise.resolve().then(action) }
  private current(scope: TranslationSourceScope): boolean { return !this.disposed && (this.options.isScopeCurrent?.(scope) ?? true) }
  private currentTerms(snapshot: TopicTermSnapshot): boolean { return this.options.isTopicTermsCurrent?.(snapshot) ?? true }
  private fresh(storageKey: string): Seat | undefined {
    const local = this.seats.get(storageKey)
    if (!this.options.storage) return local
    let raw: string | null
    try { raw = this.options.storage.getItem(storageKey) } catch { reject('storage_unavailable', '准备记录无法读取；未宣称已保存。') }
    if (raw === local?.stored) return local
    if (raw === null) { if (local?.stored !== null && local?.stored !== undefined) reject('stale_preparation', '已保存准备记录被移除，请重新读取。'); return local }
    const audit = this.decode(raw), first = audit.versions[0]!
    if (storageKey !== key(first.scope.ownerId, first.id)) reject('invalid_storage', '准备记录身份与存储位置不一致。')
    const seat: Seat = { stored: raw, audit, ...(local?.catalog === undefined ? {} : { catalog: local.catalog }), ...(local?.planningBindings === undefined ? {} : { planningBindings: local.planningBindings }) }
    this.seats.set(storageKey, seat); return seat
  }
  private lookup(query: TranslationPreparationQuery): { seat: Seat; snapshot: PreparationSnapshot } {
    const seat = this.fresh(key(query.target.mainSessionId, query.preparationId)), snapshot = seat?.audit.versions.find(item => item.version === query.version)
    if (!seat || !snapshot) reject('preparation_not_found', '指定准备包版本不存在。')
    if (!same(snapshot.target, query.target) || !this.current(snapshot.scope)) reject('scope_mismatch', '准备包不属于当前授权会话或固定原稿。')
    return { seat, snapshot }
  }
  private receipt(seat: Seat, snapshot: PreparationSnapshot, editable: boolean): PreparationReceipt {
    return { preparationId: snapshot.id, version: snapshot.version, target: snapshot.target, scope: snapshot.scope,
      sourceVersion: snapshot.sourceVersion, route: snapshot.route, totalCodePoints: snapshot.totalCodePoints,
      preparationReady: snapshot.preparationReady, executionReady: false, executionGate: 'plan_and_budget_pending',
      issueCount: snapshot.conflicts.length + Number(!snapshot.mechanicalCoverage.complete) + Number(!snapshot.modelReview.complete),
      termCount: snapshot.terms.length, candidateCount: seat.audit.candidateCount, storage: snapshot.storage, storageError: snapshot.storageError,
      editable, restartExecutable: false, createdAt: snapshot.createdAt, updatedAt: snapshot.updatedAt }
  }
  private commit(storageKey: string, seat: Seat, snapshot: PreparationSnapshot, signature: string, prepareSignature: string, candidateCount: number): Seat {
    const operationKey = snapshot.operationId, operations = { ...seat.audit.operations, [operationKey]: { signature, version: snapshot.version } }
    const versions = [...seat.audit.versions, snapshot]
    let audit: StoredPreparation = { schemaVersion: 1, cursorToken: seat.audit.cursorToken, prepareSignature, candidateCount, versions, operations }, stored = seat.stored
    const enabled = this.options.isEnabled?.() ?? true
    if (enabled && this.options.storage && this.options.withLock) {
      try {
        if (this.options.storage.getItem(storageKey) !== seat.stored) reject('stale_preparation', '准备记录在保存前发生变化，请重新读取。')
        const saved = { ...snapshot, storage: 'saved' as const, storageError: null }
        audit = { ...audit, versions: [...seat.audit.versions, saved].map(item => ({ ...item, storage: 'saved', storageError: null })) }
        const encoded = JSON.stringify(audit)
        this.options.storage.setItem(storageKey, encoded)
        if (this.options.storage.getItem(storageKey) !== encoded) reject('storage_unconfirmed', '准备记录写入结果未确认。')
        stored = encoded
      } catch (error) {
        if ((error as { code?: string }).code === 'stale_preparation') throw error
        audit = { ...audit, versions: [...seat.audit.versions, { ...snapshot, storage: 'runtime_only', storageError: '准备记录保存失败，本版本仅在运行期保留。' }] }
      }
    }
    const next: Seat = { stored, audit: immutable(audit), ...(seat.catalog === undefined ? {} : { catalog: seat.catalog }), ...(seat.planningBindings === undefined ? {} : { planningBindings: seat.planningBindings }) }
    this.seats.set(storageKey, next); return next
  }
  async prepare(args: unknown, rawFacts: PreparationPrepareFacts, measurePage?: (page: PreparationPage) => number): Promise<AnalysisResult<PreparationReceipt>> {
    try {
      const request = parseTranslationPreparationPrepare(args), facts = parsePreparationCurrentFacts({ envelope: rawFacts.envelope, topicTerms: rawFacts.topicTerms }), analysis = parsePreparationAnalysisFacts(rawFacts.analysis)
      const hash = await sourceHash(facts.envelope)
      return await this.locked(() => this.prepareLocked(request, facts, analysis, hash, measurePage))
    } catch (error) { return bad((error as { code?: string }).code ?? 'invalid_input', (error as { code?: string }).code ? (error as Error).message : '准备材料、分析事实或参数无效。', 'prepare_preparation') }
  }
  private prepareLocked(request: TranslationPreparationPrepare, facts: PreparationCurrentFacts, analysis: PreparationAnalysisFacts, hash: string, measurePage?: (page: PreparationPage) => number): AnalysisResult<PreparationReceipt> {
    const scope = materialScope(facts.envelope), run = analysis.run, total = facts.envelope.material.sourceRef?.totalCodePoints ?? sourceCodePointLength(facts.envelope.material.sourceText!)
    if (!this.current(scope) || !matchesTarget(facts.envelope, request.target) || !same(scope, run.scope) || !same(request.target, run.target) || run.sourceVersion !== request.target.sourceVersion || run.totalCodePoints !== total || request.analysisId !== run.analysisId || request.analysisVersion !== run.version || !same(run.route, facts.envelope.material.model)) return bad('source_mismatch', '分析、准备与固定原稿或实际模型路由不一致。')
    if (!this.currentTerms(facts.topicTerms)) return bad('stale_terms', '主题术语已变化，请重新读取当前条目。')
    if (!validRanges(run.requestedRanges, total) || !validRanges(run.excludedRanges, total) || overlaps(run.requestedRanges, run.excludedRanges) || !validRanges(analysis.coverage.map(item => item.range), total)) return bad('invalid_analysis', '分析覆盖范围无效。')
    if (analysis.coverage.some(item => !covers(run.requestedRanges, [item.range]) || item.candidateCount !== analysis.candidates.filter(candidate => candidate.callId === item.callId).length) || analysis.candidates.some(candidate => !analysis.coverage.some(item => item.callId === candidate.callId && candidate.occurrences.every(occurrence => occurrence.start >= item.range.start && occurrence.start < item.range.end && occurrence.end <= total)))) return bad('invalid_analysis', '候选不对应成功扫描的真实覆盖事实。')
    const storageKey = key(scope.ownerId, request.preparationId), signature = JSON.stringify(request), old = this.fresh(storageKey), catalog: Catalog = immutable({ analysis, candidates: mergePreparationCandidates(analysis.candidates), binding: binding(facts.envelope, hash) })
    if (old) {
      if (old.audit.prepareSignature !== signature || !same(old.audit.versions[0]!.target, request.target)) return bad('idempotency_conflict', '此准备标识已绑定另一分析或操作。')
      // Replaying a prepare may reattach the still-authorized runtime catalog; it never fabricates one after restart.
      if (!old.catalog) return bad('analysis_unavailable', '此快照来自已保存审计，不能重新附会运行期分析或原稿。')
      if (!same(analysisBusinessFacts(old.catalog.analysis), analysisBusinessFacts(analysis))) return bad('analysis_changed', '原分析事实发生变化；请创建新的准备包。')
      const snapshot = old.audit.versions[old.audit.operations[request.operationId]!.version - 1]!
      return ok(this.receipt(old, snapshot, true))
    }
    if ([...this.seats.values()].some(seat => seat.audit.versions[0]?.scope.ownerId === scope.ownerId && Object.hasOwn(seat.audit.operations, request.operationId))) return bad('idempotency_conflict', '此操作标识已绑定另一准备包。')
    const required = requiredRanges(run.excludedRanges, total), complete = covers(analysis.coverage.map(item => item.range), required), at = now()
    const snapshot: PreparationSnapshot = { schemaVersion: 1, id: request.preparationId, version: 1, target: request.target, scope,
      sourceVersion: request.target.sourceVersion, sourceSha256: hash, totalCodePoints: total, route: run.route, targetLanguage: facts.envelope.material.targetLanguage,
      userRequirements: facts.envelope.material.instruction, organizedRequirements: '', mechanicalCoverage: { meaning: 'mechanical_source_scan', analysisId: run.analysisId, analysisVersion: 1,
        requestedRanges: run.requestedRanges, excludedRanges: run.excludedRanges, requiredRanges: required, coverage: analysis.coverage, complete },
      modelReview: { meaning: 'main_model_declared_review', reviewedRanges: [], complete: required.length === 0 }, terms: [], backgroundRanges: [], referenceRefs: [], questions: [], conflicts: [],
      preparationReady: false, executionReady: false, executionGate: 'plan_and_budget_pending', storage: 'runtime_only', storageError: null, createdAt: at, updatedAt: at, operationId: request.operationId }
    const empty: Seat = { stored: null, audit: { schemaVersion: 1, cursorToken: crypto.randomUUID(), prepareSignature: signature, candidateCount: catalog.candidates.length, versions: [], operations: {} }, catalog }
    this.readable(empty, snapshot, measurePage)
    const next = this.commit(storageKey, empty, snapshot, signature, signature, catalog.candidates.length)
    return ok(this.receipt(next, next.audit.versions[0]!, true))
  }
  async set(args: unknown, rawFacts: PreparationCurrentFacts, measurePage?: (page: PreparationPage) => number): Promise<AnalysisResult<PreparationReceipt>> {
    try {
      const request = parseTranslationPreparationSet(args), facts = parsePreparationCurrentFacts(rawFacts)
      const [hash, signature] = await Promise.all([sourceHash(facts.envelope), textHash(JSON.stringify(request))])
      return await this.locked(() => this.setLocked(request, facts, hash, signature, measurePage))
    } catch (error) { return bad((error as { code?: string }).code ?? 'invalid_input', (error as { code?: string }).code ? (error as Error).message : '准备采用参数或当前事实无效。', 'set_preparation') }
  }
  private setLocked(request: TranslationPreparationSet, facts: PreparationCurrentFacts, hash: string, signature: string, measurePage?: (page: PreparationPage) => number): AnalysisResult<PreparationReceipt> {
    const storageKey = key(request.target.mainSessionId, request.preparationId), seat = this.fresh(storageKey), latest = seat?.audit.versions.at(-1)
    if (!seat || !latest) return bad('preparation_not_found', '准备包不存在。')
    if (!this.current(latest.scope) || !same(latest.target, request.target) || !matchesTarget(facts.envelope, request.target) || !same(materialScope(facts.envelope), latest.scope) || hash !== latest.sourceSha256) return bad('source_mismatch', '准备包与当前固定原稿不一致。')
    if (!seat.catalog || seat.catalog.binding !== binding(facts.envelope, hash)) return bad('analysis_unavailable', '原稿或分析仅在原运行期有效；保存快照只可查阅。')
    if (!this.currentTerms(facts.topicTerms)) return bad('stale_terms', '主题术语已变化，请重新读取当前条目。')
    const repeated = Object.hasOwn(seat.audit.operations, request.operationId) ? seat.audit.operations[request.operationId] : undefined
    if (repeated) return repeated.signature === signature ? ok(this.receipt(seat, seat.audit.versions[repeated.version - 1]!, true)) : bad('idempotency_conflict', '此操作标识已绑定不同准备内容。')
    if ([...this.seats.values()].some(other => other !== seat && other.audit.versions[0]?.scope.ownerId === latest.scope.ownerId && Object.hasOwn(other.audit.operations, request.operationId))) return bad('idempotency_conflict', '此操作标识已绑定另一准备包。')
    if (request.expectedVersion !== latest.version) return bad('stale_preparation', '准备包已更新，请使用当前版本。')
    if (request.referenceRefs?.length) return bad('reference_unavailable', '外部参考资料尚无受权登记与范围读取；不能把原稿或推断伪装成参考查证。')
    const required = latest.mechanicalCoverage.requiredRanges, total = latest.totalCodePoints
    if (!validRanges(request.reviewedRanges, total) || !validRanges(request.backgroundRanges ?? [], total) || request.questions?.some(item => !validRanges(item.ranges, total))) return bad('invalid_range', '审阅、背景或问题范围超出固定原稿。')
    const terms: PreparationFrozenTerm[] = []
    for (const selected of request.termSelections) {
      if (!validRanges(selected.ranges, total) || !applicableRanges(selected.ranges, required)) return bad('invalid_range', '术语适用范围必须位于完整需译范围内。')
      if (selected.ref.kind === 'candidate') {
        const candidate = seat.catalog.candidates.find(item => item.members.some(member => member.id === selected.ref.id))
        if (!candidate) return bad('candidate_not_found', '指定候选版本不存在。')
        if (terms.some(term => term.ref.kind === 'candidate' && term.ref.id === candidate.id)) return bad('duplicate_candidate', '同词同译法候选已合并，请用一个范围列表采用。')
        let description = candidate.descriptions[0]!.description
        if (candidate.descriptions.length > 1 && !selected.descriptionRef && selected.content?.description === undefined) return bad('description_conflict', '同词同译法含不同说明，请按真实候选引用选择说明或给出任务说明。')
        if (selected.descriptionRef) {
          const option = candidate.descriptions.find(item => item.candidateRefs.some(ref => same(ref, selected.descriptionRef)))
          if (!option) return bad('description_mismatch', '所选说明不属于此候选。')
          description = option.description
        }
        if (selected.content && selected.content.original !== candidate.original) return bad('candidate_spelling_mismatch', '任务译法调整必须绑定候选的精确原词，不能替换原词或正文。')
        const adoptedMember = candidate.members.find(member => member.id === selected.ref.id)!, descriptionMember = selected.descriptionRef && candidate.members.find(member => member.id === selected.descriptionRef!.id)
        terms.push({ ref: { kind: 'candidate', id: candidate.id, version: 1 }, sourceForms: [candidate.original], aliases: [], preferred: selected.content?.preferred ?? candidate.preferred, description: selected.content?.description ?? description,
          sourceLanguage: null, targetLanguage: latest.targetLanguage, sense: '', forbidden: [], userFixed: false, confirmation: null, origin: selected.content ? 'main_model_adjusted' : 'model_inferred', evidence: [],
          candidateRefs: [adoptedMember, ...(descriptionMember && descriptionMember.id !== adoptedMember.id ? [descriptionMember] : [])], ranges: selected.ranges })
      } else {
        const ref = selected.ref, entry = facts.topicTerms.entries.find(item => item.id === ref.id)
        if (!entry || entry.version !== ref.entryVersion) return bad('stale_terms', '指定主题术语已更新或删除。')
        if (entry.status !== 'active' || entry.targetLanguage !== latest.targetLanguage) return bad('term_unavailable', '此主题术语未启用或不适用于当前目标语言。')
        if (selected.descriptionRef || selected.content) return bad('description_mismatch', '主题术语正文由当前条目冻结，不能在任务采用中替换。')
        terms.push({ ref, sourceForms: entry.sourceForms, aliases: entry.aliases, preferred: entry.preferred, description: entry.sense,
          sourceLanguage: entry.sourceLanguage, targetLanguage: entry.targetLanguage, sense: entry.sense, forbidden: entry.forbidden,
          userFixed: fixed(entry), confirmation: entry.confirmation, origin: entry.origin, evidence: entry.evidence, candidateRefs: [], ranges: selected.ranges })
      }
    }
    const conflicts = this.conflicts(seat.catalog.candidates, facts.topicTerms, terms, required, request, latest.targetLanguage)
    // An adopted conflicting spelling never replaces a user-fixed rule, even in an incomplete draft.
    if (conflicts.some(item => item.code === 'fixed_conflict')) return bad('fixed_conflict', '任务采用与用户固定译法或禁用译法冲突；请分配不重叠语义范围并保留固定条目。')
    const reviewedComplete = covers(request.reviewedRanges, required), at = now()
    const snapshot: PreparationSnapshot = { ...latest, version: latest.version + 1, organizedRequirements: request.organizedRequirements,
      modelReview: { meaning: 'main_model_declared_review', reviewedRanges: request.reviewedRanges, complete: reviewedComplete },
      terms, backgroundRanges: request.backgroundRanges ?? [], referenceRefs: [], questions: request.questions ?? [], conflicts,
      preparationReady: latest.mechanicalCoverage.complete && reviewedComplete && conflicts.length === 0,
      storage: 'runtime_only', storageError: null, updatedAt: at, operationId: request.operationId }
    if (preparationPacketBytes(snapshot) > MAX_PREPARATION_PACKET_BYTES) return bad('preparation_too_large', '固定准备快照超过单包预算；未截字段或静默漏选。')
    this.readable(seat, snapshot, measurePage)
    const bound: Seat = { ...seat, planningBindings: { ...seat.planningBindings, [snapshot.version]: fixedBinding(facts.topicTerms, snapshot.targetLanguage) } }
    const next = this.commit(storageKey, bound, snapshot, signature, seat.audit.prepareSignature, seat.audit.candidateCount)
    return ok(this.receipt(next, next.audit.versions.at(-1)!, true))
  }
  private conflicts(candidates: readonly PreparationCandidate[], topic: TopicTermSnapshot, terms: readonly PreparationFrozenTerm[], required: readonly TranslationSourceRange[], request: TranslationPreparationSet, targetLanguage: string): readonly PreparationConflict[] {
    const conflicts: PreparationConflict[] = [], forms = new Map<string, PreparationCandidate[]>()
    for (const candidate of candidates) { const old = forms.get(candidate.original); if (old) old.push(candidate); else forms.set(candidate.original, [candidate]) }
    for (const [original, options] of forms) {
      const selected = terms.filter(term => [...term.sourceForms, ...term.aliases].includes(original))
      if (options.length > 1 && !selected.length) conflicts.push({ code: 'candidate_scope_unresolved', original, refs: options.map(item => ({ kind: 'candidate', id: item.id, version: 1 })), ranges: options.flatMap(item => item.occurrences).slice(0, 8), message: '同原词不同译法尚未作出任务采用决定。' })
      const relevantFixed = topic.entries.filter(entry => entry.status === 'active' && fixed(entry) && entry.targetLanguage === targetLanguage && [...entry.sourceForms, ...entry.aliases].includes(original))
      if (relevantFixed.length && !selected.some(term => term.userFixed)) conflicts.push({ code: 'fixed_scope_unresolved', original, refs: relevantFixed.map(entry => ({ kind: 'topic_term', id: entry.id, entryVersion: entry.version })), ranges: selected.length ? selected.flatMap(term => term.ranges) : options.flatMap(item => item.occurrences).slice(0, 8), message: '此原词存在用户固定规则，需明确采用真实固定语义及其适用范围。' })
    }
    for (const term of terms.filter(item => !item.userFixed)) {
      const relevantFixed = topic.entries.filter(entry => entry.status === 'active' && fixed(entry) && entry.targetLanguage === targetLanguage &&
        (term.sourceLanguage === null || entry.sourceLanguage === term.sourceLanguage) && [...entry.sourceForms, ...entry.aliases].some(form => [...term.sourceForms, ...term.aliases].includes(form)))
      if (relevantFixed.length && !terms.some(item => item.userFixed && sharedForms(item, term).length) && !conflicts.some(item => item.code === 'fixed_scope_unresolved' && [...term.sourceForms, ...term.aliases].includes(item.original))) conflicts.push({
        code: 'fixed_scope_unresolved', original: term.sourceForms[0]!, refs: relevantFixed.map(entry => ({ kind: 'topic_term', id: entry.id, entryVersion: entry.version })),
        ranges: term.ranges, message: '任务采用不能通过遗漏当前用户固定条目绕过固定规则。',
      })
    }
    for (let index = 0; index < terms.length; index++) for (const other of terms.slice(index + 1)) {
      const term = terms[index]!, common = sharedForms(term, other)
      if (!common.length || term.targetLanguage !== other.targetLanguage || !overlaps(term.ranges, other.ranges)) continue
      // Distinct explicitly identified source languages are separate terminology contexts.
      if (term.sourceLanguage !== null && other.sourceLanguage !== null && term.sourceLanguage !== other.sourceLanguage) continue
      if (term.preferred !== other.preferred || term.forbidden.includes(other.preferred) || other.forbidden.includes(term.preferred) || (term.sense !== other.sense && term.ref.kind === 'topic_term' && other.ref.kind === 'topic_term')) conflicts.push({ code: term.userFixed || other.userFixed ? 'fixed_conflict' : 'term_scope_conflict', original: common[0]!, refs: [term.ref, other.ref], ranges: [...term.ranges, ...other.ranges], message: '同原词不同语义、译法或禁用约束的适用范围重叠。' })
    }
    for (const question of request.questions ?? []) if (question.decision === null) conflicts.push({ code: 'question_unresolved', original: '', refs: [], ranges: question.ranges, message: question.question })
    return conflicts
  }
  status(args: unknown, envelope?: Extract<TranslationMaterialEnvelope, { kind: 'material' }>): AnalysisResult<PreparationReceipt> {
    try {
      const query = parseTranslationPreparationQuery(args), { seat, snapshot } = this.lookup(query)
      return ok(this.receipt(seat, snapshot, !!seat.catalog && !!envelope && matchesTarget(envelope, query.target)))
    } catch (error) { return bad((error as { code?: string }).code ?? 'invalid_input', (error as { code?: string }).code ? (error as Error).message : '准备查询参数或保存记录无效。', 'read_preparation') }
  }
  /** Private planning capture: saved audits alone never recreate runtime preparation authority. */
  async capture(args: unknown, rawFacts: PreparationCurrentFacts, relevantFixedIds: readonly string[], measureReply: (snapshot: PreparationSnapshot) => number): Promise<AnalysisResult<PreparationSnapshot>> {
    try {
      const query = parseTranslationPreparationQuery(args), facts = parsePreparationCurrentFacts(rawFacts), hash = await sourceHash(facts.envelope)
      return await this.locked(() => {
        const { seat, snapshot } = this.lookup(query)
        if (!matchesTarget(facts.envelope, query.target) || !same(materialScope(facts.envelope), snapshot.scope) || hash !== snapshot.sourceSha256) return bad('source_mismatch', '规划准备与当前固定原稿不一致。', 'capture_preparation')
        if (!seat.catalog || seat.catalog.binding !== binding(facts.envelope, hash)) return bad('analysis_unavailable', '已保存准备仅供审计；规划需要原运行期的真实材料与分析。', 'capture_preparation')
        if (!snapshot.preparationReady || !snapshot.mechanicalCoverage.complete || !snapshot.modelReview.complete || snapshot.conflicts.length || snapshot.questions.some(question => question.decision === null) || seat.planningBindings?.[snapshot.version] === undefined) return bad('preparation_not_ready', '准备扫描、主模型审阅或关键问题尚未完整解决；请形成新的准备版本。', 'capture_preparation')
        if (!this.currentTerms(facts.topicTerms)) return bad('stale_terms', '主题术语在规划捕获时已变化，请重新读取。', 'capture_preparation')
        const baseline = seat.planningBindings[snapshot.version]!, adoptedFixed = snapshot.terms.filter(term => term.userFixed), knownForms = new Set([...seat.catalog.candidates.map(candidate => candidate.original), ...snapshot.terms.flatMap(term => [...term.sourceForms, ...term.aliases])])
        const currentFixed = facts.topicTerms.entries.filter(entry => entry.status === 'active' && entry.targetLanguage === snapshot.targetLanguage && fixed(entry))
        if (adoptedFixed.some(term => term.ref.kind !== 'topic_term' || !currentFixed.some(entry => entry.id === term.ref.id && entry.version === (term.ref as Extract<PreparationTermRef, { kind: 'topic_term' }>).entryVersion && same(entry.confirmation, term.confirmation) && entry.preferred === term.preferred && same(entry.forbidden, term.forbidden) && same(entry.sourceForms, term.sourceForms) && same(entry.aliases, term.aliases) && entry.sourceLanguage === term.sourceLanguage && entry.sense === term.sense && entry.sense === term.description && entry.origin === term.origin && same(entry.evidence, term.evidence)))) return bad('stale_fixed_terms', '已采用的用户固定条目已更新或删除，请重新形成准备版本。', 'capture_preparation')
        const related = currentFixed.filter(entry => relevantFixedIds.includes(entry.id) || [...entry.sourceForms, ...entry.aliases].some(form => knownForms.has(form)))
        const missing = related.filter(entry => relevantFixedIds.includes(entry.id) && !adoptedFixed.some(term => [...term.sourceForms, ...term.aliases].some(form => [...entry.sourceForms, ...entry.aliases].includes(form))))
        if (missing.length) return bad('preparation_incomplete', `原稿命中的用户固定原词尚未采用，请在新准备版本分配实际语义范围：${missing.map(entry => entry.id).join(', ').slice(0, 700)}`, 'capture_preparation')
        if (related.some(entry => baseline[entry.id] !== entry.version)) return bad('stale_fixed_terms', '原稿相关的用户固定条目已变化，请重新形成准备版本。', 'capture_preparation')
        if (measureReply(snapshot) > MAX_PREPARATION_PACKET_BYTES) return bad('preparation_too_large', '完整私有准备回包超过 196608 字节；未截字段或开始规划。', 'capture_preparation')
        return ok(snapshot)
      })
    } catch (error) { return bad((error as { code?: string }).code ?? 'invalid_input', (error as { code?: string }).code ? (error as Error).message : '规划准备捕获参数或当前事实无效。', 'capture_preparation') }
  }
  read(args: unknown, measureReply: (page: PreparationPage) => number = page => preparationPacketBytes({ ok: true, value: page })): AnalysisResult<PreparationPage> {
    try {
      const request = parseTranslationPreparationRead(args), { seat, snapshot } = this.lookup(request)
      if (request.section === 'candidates' && !seat.catalog) return bad('analysis_unavailable', '分析候选只在原运行期保留；已保存准备快照仍可查阅。', 'read_preparation')
      const items = this.section(seat, snapshot, request.section), cursorPrefix = `${seat.audit.cursorToken}:${snapshot.version}:${request.section}:`, cursor = request.cursor
      let offset = 0
      if (cursor !== undefined) {
        if (!cursor.startsWith(cursorPrefix) || !/^\d+$/u.test(cursor.slice(cursorPrefix.length))) return bad('invalid_cursor', '准备游标不属于此版本或区段。', 'read_preparation')
        offset = Number(cursor.slice(cursorPrefix.length))
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > items.length) return bad('invalid_cursor', '准备游标超出范围。', 'read_preparation')
      }
      const selected: unknown[] = [], limit = request.limit ?? MAX_PREPARATION_PAGE_ITEMS
      const page = (): PreparationPage => ({ target: request.target, preparationId: request.preparationId, version: request.version, section: request.section, items: selected, nextCursor: offset + selected.length < items.length ? `${cursorPrefix}${offset + selected.length}` : null })
      while (selected.length < limit && offset + selected.length < items.length) {
        selected.push(items[offset + selected.length])
        if (measureReply(page()) > MAX_PREPARATION_PAGE_BYTES) {
          selected.pop()
          if (!selected.length) return bad('item_too_large', '单项准备事实超过完整 32768 字节读取预算；未截字段。', 'read_preparation')
          break
        }
      }
      if (measureReply(page()) > MAX_PREPARATION_PAGE_BYTES) return bad('reply_too_large', '准备读取身份超过完整回复预算。', 'read_preparation')
      return ok(page())
    } catch (error) { return bad((error as { code?: string }).code ?? 'invalid_input', (error as { code?: string }).code ? (error as Error).message : '准备读取参数或保存记录无效。', 'read_preparation') }
  }
  private section(seat: Seat, snapshot: PreparationSnapshot, section: TranslationPreparationRead['section']): readonly unknown[] {
    switch (section) {
      case 'summary': return [{ userRequirements: snapshot.userRequirements, organizedRequirements: snapshot.organizedRequirements, route: snapshot.route, sourceSha256: snapshot.sourceSha256,
        targetLanguage: snapshot.targetLanguage, mechanicalCoverageComplete: snapshot.mechanicalCoverage.complete, mainModelReviewComplete: snapshot.modelReview.complete,
        preparationReady: snapshot.preparationReady, executionReady: false, executionGate: 'plan_and_budget_pending',
        coverageMeaning: snapshot.mechanicalCoverage.meaning, reviewMeaning: snapshot.modelReview.meaning }]
      case 'candidates': return seat.catalog!.candidates.flatMap(candidate => [
        { kind: 'candidate', id: candidate.id, version: candidate.version, original: candidate.original, preferred: candidate.preferred,
          memberCount: candidate.members.length, descriptionCount: candidate.descriptions.length, occurrences: candidate.occurrences.slice(0, 8),
          occurrenceCount: candidate.occurrenceCount, occurrenceSamples: candidate.occurrenceSamples, origin: candidate.origin },
        ...candidate.descriptions.map(option => ({ kind: 'description', candidateId: candidate.id, description: option.description, descriptionRef: option.candidateRefs[0] })),
        ...candidate.members.map(member => ({ kind: 'analysis_source', candidateId: candidate.id, ...member })),
      ])
      case 'terms': return snapshot.terms
      case 'coverage': return [
        ...snapshot.mechanicalCoverage.requiredRanges.map(range => ({ kind: 'required', range })),
        ...snapshot.mechanicalCoverage.excludedRanges.map(range => ({ kind: 'excluded', range })),
        ...snapshot.mechanicalCoverage.coverage.map(item => ({ kind: 'mechanical_scan', analysisId: snapshot.mechanicalCoverage.analysisId, analysisVersion: 1, ...item })),
        ...snapshot.modelReview.reviewedRanges.map(range => ({ kind: 'main_model_declared_review', range })),
      ]
      case 'background': return snapshot.backgroundRanges.map(range => ({ target: snapshot.target, sourceVersion: snapshot.sourceVersion, range, role: 'source_background' }))
      case 'references': return snapshot.referenceRefs
      case 'questions': return snapshot.questions
      case 'conflicts': return snapshot.conflicts
    }
  }
  private readable(seat: Seat, snapshot: PreparationSnapshot, measurePage: (page: PreparationPage) => number = page => preparationPacketBytes({ requestId: 'preflight', ok: true, value: { kind: 'preparation_page', page } })): void {
    for (const section of ['summary', 'candidates', 'terms', 'coverage', 'background', 'references', 'questions', 'conflicts'] as const) {
      const items = this.section(seat, snapshot, section)
      for (const [offset, item] of items.entries()) {
        const page: PreparationPage = { target: snapshot.target, preparationId: snapshot.id, version: snapshot.version, section, items: [item],
          nextCursor: `${seat.audit.cursorToken}:${snapshot.version}:${section}:${offset + 1}` }
        if (measurePage(page) > MAX_PREPARATION_PAGE_BYTES) reject('preparation_item_too_large', '单项准备事实超过完整 32768 字节页预算；未采用、保存或截掉字段。')
      }
    }
  }
  private decode(raw: string): StoredPreparation {
    const input = JSON.parse(raw) as StoredPreparation
    if (!input || typeof input !== 'object' || Object.keys(input).length !== 6 || !['schemaVersion', 'cursorToken', 'prepareSignature', 'candidateCount', 'versions', 'operations'].every(field => Object.hasOwn(input, field))) throw new TypeError('Unexpected preparation audit fields')
    const audit = { ...input, versions: input.versions.map(parsePreparationSnapshot) }
    if (!audit || audit.schemaVersion !== 1 || typeof audit.cursorToken !== 'string' || !/^[0-9a-f-]{36}$/u.test(audit.cursorToken) || typeof audit.prepareSignature !== 'string' || !Number.isSafeInteger(audit.candidateCount) || audit.candidateCount < 0 || !Array.isArray(audit.versions) || !audit.versions.length || !audit.operations || typeof audit.operations !== 'object' || Array.isArray(audit.operations)) throw new TypeError('Invalid preparation audit')
    const first = audit.versions[0]!
    for (const [index, snapshot] of audit.versions.entries()) {
      if (snapshot.version !== index + 1 || snapshot.id !== first.id || !same(snapshot.target, first.target) || !same(snapshot.scope, first.scope) || snapshot.sourceSha256 !== first.sourceSha256 || !same(snapshot.route, first.route) || snapshot.targetLanguage !== first.targetLanguage || snapshot.userRequirements !== first.userRequirements || !same(snapshot.mechanicalCoverage, first.mechanicalCoverage) || snapshot.storage !== 'saved') throw new TypeError('Invalid preparation audit version')
      const calculated = snapshot.mechanicalCoverage.complete && snapshot.modelReview.complete && snapshot.conflicts.length === 0
      if (snapshot.version > 1 && snapshot.preparationReady !== calculated) throw new TypeError('Invalid preparation eligibility')
      if (!Array.isArray(snapshot.terms) || !Array.isArray(snapshot.questions) || !Array.isArray(snapshot.conflicts) || !Array.isArray(snapshot.backgroundRanges) || snapshot.referenceRefs.length) throw new TypeError('Invalid preparation audit content')
    }
    for (const [operationId, operation] of Object.entries(audit.operations)) if (!operationId || typeof operation.signature !== 'string' || !Number.isSafeInteger(operation.version) || !audit.versions[operation.version - 1] || audit.versions[operation.version - 1]!.operationId !== operationId) throw new TypeError('Invalid preparation audit operation')
    return immutable(audit)
  }
}
