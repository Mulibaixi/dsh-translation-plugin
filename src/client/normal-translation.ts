import { parseNormalTranslationAcceptance, parseNormalTranslationUpdate, parseNormalTranslationJob, parseNormalTranslationTarget, parseNormalTranslationSourceCorrection, type NormalTranslationAcceptance,
  type NormalTranslationOperation, type NormalTranslationUpdate, type NormalTranslationQuery, type NormalTranslationUnitTarget, type NormalTranslationSourceCorrection, type NormalTranslationUnitRequest } from '../shared/normal-translation.js'
import { parseTranslationMaterialEnvelope, type TranslationMaterialEnvelope } from '../shared/translation-material.js'
import type { TopicBridgeValue } from '../shared/topic-bridge.js'
import type { TopicTermSnapshot } from '../memory/topic-terms.js'
import type { TranslationCallMetadata } from '../shared/translation-call.js'
import { appendAdmittedTextUnit, appendTextRevision, updateTextRevision, appendTranslationEvent, appendSourceCorrection, acceptUnitRetranslation } from './translation-history.js'
import type { SessionStore } from './session-store.js'
import type { MaterialSubmissionsClient } from './material-submissions.js'
import type { TopicBridgeTermsPort } from './topic-bridge.js'

export type NormalTranslationReply = { readonly ok: true; readonly value: Extract<TopicBridgeValue, { kind: 'normal_operation' | 'normal_prepared' | 'normal_updated' | 'normal_observed' | 'normal_resolved' | 'normal_source_corrected' }> }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
export interface NormalTranslationRemotePort {
  status(request: NormalTranslationQuery): Promise<unknown>
  cancel(request: NormalTranslationQuery): Promise<unknown>
  requestUnit?(request: NormalTranslationUnitRequest): Promise<unknown>
}
interface AcceptedOperation {
  readonly signature: string
  operation: NormalTranslationOperation
  readonly termSnapshot: TopicTermSnapshot
  release: (() => void) | undefined
  callId: string | null
  sequence: number
  text: string
  message: string | undefined
  querying: boolean
  readonly updates: Map<number, string>
}
const failure = (code: string, message: string): NormalTranslationReply => ({ ok: false, error: { code, message } })

/** Admission facts live in SessionStore; this runtime index only correlates short bridge receipts. */
export class NormalTranslationClient {
  private readonly operations = new Map<string, AcceptedOperation>()
  private readonly unitSnapshots = new Map<string, Extract<TranslationMaterialEnvelope, { kind: 'material' }>>()
  private readonly unitRequests = new Map<string, { operationId: string; pending: boolean; outcome: 'pending' | 'submitted' | 'failed' | 'unknown'; message: string; release: (() => void) | undefined }>()
  private readonly listeners = new Set<() => void>()
  private readonly stopBridge: (() => void) | undefined
  private disposed = false
  constructor(private readonly store: SessionStore, private readonly materials: MaterialSubmissionsClient,
    private readonly terms: TopicBridgeTermsPort, private readonly retain: (ownerId: string) => () => void,
    private readonly options: { readonly isSessionBusy?: (sessionId: string) => boolean;
      readonly remote?: NormalTranslationRemotePort | (() => Promise<NormalTranslationRemotePort | undefined>) | undefined;
      readonly subscribeBridge?: (listener: () => void) => () => void;
      readonly bridgeReady?: (ownerId: string) => boolean;
      readonly canAccessUnit?: (ownerId: string, sessionId: string, unitId: string) => boolean;
      readonly canCorrectSource?: (ownerId: string, topicId: string, sessionId: string, unitId: string) => boolean;
      readonly publishUnit?: (ownerId: string, sessionId: string, unitId: string) => boolean } = {}) {
    this.stopBridge = options.subscribeBridge?.(() => {
      for (const item of this.operations.values()) if (['accepted', 'running'].includes(item.operation.status) && options.bridgeReady?.(item.operation.mainSessionId) === false) this.unknown(item, '普通翻译连接中断，请查询本轮状态；未自动重发。')
    })
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private emit(): void { if (!this.disposed) for (const listener of this.listeners) listener() }
  private key(ownerId: string, operationId: string): string { return JSON.stringify([ownerId, operationId]) }

  resolve(ownerId: string, input: { readonly target: NormalTranslationUnitTarget; readonly operationId: string }): NormalTranslationReply {
    const target = parseNormalTranslationTarget(input.target)
    if (target.kind !== 'unit') return failure('invalid_input', '需要明确的历史单元引用。')
    const session = this.store.getSession(target.translationSessionId), unit = this.store.getTranslationHistory(target.translationSessionId)?.units.find(unit => unit.id === target.unitId)
    if (this.disposed || target.mainSessionId !== ownerId || !session || session.ownerId !== ownerId || this.store.isSessionDeleted(session.id) || !unit ||
      !this.options.canAccessUnit?.(ownerId, session.id, unit.id)) return failure('reference_not_published', '此单元尚未明确提供给当前主模型。')
    if (session.mode !== 'normal' || session.archivedAt !== null) return failure('invalid_state', '请先恢复普通会话再处理历史单元。')
    if (unit.sourceVersion !== target.sourceVersion || this.store.getStatus(session.id) === 'conflict') return failure('stale_version', '原文版本已变化，请读取当前单元。')
    const key = this.key(ownerId, input.operationId), cached = this.unitSnapshots.get(key)
    if (cached) return cached.material.translationSessionId === session.id && cached.material.unitReference?.unitId === unit.id && cached.material.sourceVersion === target.sourceVersion
      ? { ok: true, value: { kind: 'normal_resolved', envelope: structuredClone(cached) } } : failure('idempotency_conflict', '此业务操作已冻结其他历史单元。')
    if (this.store.getAvailableSessions(ownerId).some(candidate => this.store.getTranslationHistory(candidate.id)?.events.some(event => event.operationId === input.operationId))) return failure('idempotency_conflict', '此操作已有历史事实，请查询原操作。')
    if (!session.model) return failure('invalid_input', '请为此翻译会话选择模型。')
    if (Array.from(unit.source).length > session.maxInputChars) return failure('input_too_large', '当前原文超过此会话单次上限，未截断。')
    const envelope = parseTranslationMaterialEnvelope({ ownerId, mainSessionId: ownerId, requestId: `unit-request:${input.operationId}`, operationId: input.operationId, kind: 'material', material: {
      materialId: unit.material?.materialId ?? unit.id, sourceVersion: target.sourceVersion, topicId: session.topicId, translationSessionId: session.id,
      draftVersion: unit.material?.draftVersion ?? 1, sourceText: unit.source, targetLanguage: unit.targetLanguage, instruction: unit.instruction,
      model: session.model, maxInputChars: session.maxInputChars, unitReference: { unitId: unit.id, sourceVersion: target.sourceVersion },
    } }) as Extract<TranslationMaterialEnvelope, { kind: 'material' }>
    this.unitSnapshots.set(key, envelope)
    return { ok: true, value: { kind: 'normal_resolved', envelope: structuredClone(envelope) } }
  }

  correctSource(ownerId: string, input: NormalTranslationSourceCorrection): NormalTranslationReply {
    const request = parseNormalTranslationSourceCorrection(input), target = request.target
    const session = this.store.getSession(target.translationSessionId), history = this.store.getTranslationHistory(target.translationSessionId), unit = history?.units.find(unit => unit.id === target.unitId)
    if (this.disposed || target.mainSessionId !== ownerId || !session || session.ownerId !== ownerId || !unit || this.store.isSessionDeleted(session.id) ||
      !this.options.canAccessUnit?.(ownerId, session.id, unit.id)) return failure('reference_not_published', '此单元尚未明确提供给当前主模型。')
    const previous = this.store.getAvailableSessions(ownerId).flatMap(candidate => this.store.getTranslationHistory(candidate.id)?.events ?? []).find(event => event.operationId === request.operationId)
    if (previous) {
      const source = unit.sourceVersions.find(source => source.operationId === request.operationId)
      if (previous.type !== 'source.corrected' || previous.unitId !== unit.id || !source || source.version !== target.sourceVersion + 1 || source.text !== request.sourceText || previous.sourceReason !== request.reason) return failure('idempotency_conflict', '此操作已有不同的历史事实，未重复纠错。')
      return { ok: true, value: { kind: 'normal_source_corrected', correction: { operationId: request.operationId, mainSessionId: ownerId,
        translationSessionId: session.id, unitId: unit.id, previousSourceVersion: target.sourceVersion, sourceVersion: source.version,
        persistence: this.store.getStatus(session.id) === 'saved' ? 'saved' : 'runtime_only' } } }
    }
    if (this.unitSnapshots.has(this.key(ownerId, request.operationId)) || this.operations.has(this.key(ownerId, request.operationId))) return failure('idempotency_conflict', '此操作已用于翻译准备，纠错需要独立操作。')
    if (session.mode !== 'normal' || session.archivedAt !== null) return failure('invalid_state', '请先恢复普通会话再纠错。')
    if (unit.sourceVersion !== target.sourceVersion || this.store.getStatus(session.id) === 'conflict') return failure('stale_version', '原文已变化，未覆盖旧版本。')
    if (this.options.canCorrectSource?.(ownerId, session.topicId, session.id, unit.id) === false) return failure('source_objects_linked', '原文含原件位置关联，暂不支持自动改写；原件与位置仍保留。')
    if (request.sourceText === unit.source) return failure('unchanged_source', '原文内容未变化。')
    if (Array.from(request.sourceText).length > session.maxInputChars) return failure('input_too_large', '更正原文超过此会话上限，未截断。')
    if (!this.store.updateTranslationHistory(session.id, current => appendSourceCorrection(current, unit.id, { operationId: request.operationId,
      expectedVersion: target.sourceVersion, text: request.sourceText, reason: request.reason, at: new Date().toISOString() }))) return failure('history_update_failed', '原文纠错记录未完成，请读取当前版本。')
    return { ok: true, value: { kind: 'normal_source_corrected', correction: { operationId: request.operationId, mainSessionId: ownerId,
      translationSessionId: session.id, unitId: unit.id, previousSourceVersion: target.sourceVersion, sourceVersion: target.sourceVersion + 1,
      persistence: this.store.getStatus(session.id) === 'saved' ? 'saved' : 'runtime_only' } } }
  }

  prepare(ownerId: string, input: NormalTranslationAcceptance): NormalTranslationReply {
    if (this.disposed) return failure('execution_unavailable', '普通翻译业务通道已关闭。')
    const request = parseNormalTranslationAcceptance(input)
    if (request.envelope.material.sourceRef) return failure('requires_batch', 'TXT 原稿已可供准备；整篇分批翻译尚未接入。')
    const previous = this.locate(ownerId, request.operationId)
    if (previous) return previous.signature === JSON.stringify(request) ? { ok: true, value: { kind: 'normal_prepared', termSnapshot: structuredClone(previous.termSnapshot) } }
      : failure('idempotency_conflict', '此业务操作已用于其他材料或要求，未重复准备。')
    const envelope = request.envelope, material = envelope.material, session = this.store.getSession(material.translationSessionId)
    if (envelope.mainSessionId !== ownerId || envelope.ownerId !== ownerId || !session || session.ownerId !== ownerId || session.topicId !== material.topicId ||
      this.store.isSessionDeleted(session.id) || !this.store.getTopics(ownerId).some(topic => topic.id === material.topicId)) return failure('out_of_scope', '材料不属于当前主会话、主题或翻译会话。')
    if (session.mode !== 'normal' || session.archivedAt !== null) return failure('invalid_state', '普通翻译会话已不可执行，请恢复会话后重新提交材料。')
    if (this.store.getStatus(session.id) === 'conflict') return failure('stale_version', '本地历史已变化，请先核对当前副本。')
    if (material.unitReference) {
      const cached = this.unitSnapshots.get(this.key(ownerId, request.operationId)), unit = this.store.getTranslationHistory(session.id)?.units.find(unit => unit.id === material.unitReference?.unitId)
      if (!cached || JSON.stringify(cached) !== JSON.stringify(envelope) || !this.options.canAccessUnit?.(ownerId, session.id, material.unitReference.unitId)) return failure('reference_not_published', '历史处理材料未由当前Client冻结或授权。')
      if (!unit || unit.sourceVersion !== material.sourceVersion || material.unitReference.sourceVersion !== unit.sourceVersion) return failure('stale_version', '准备后原文已变化，请使用新操作重新准备。')
    } else {
      if (!this.materials.resolveSubmittedMaterial(envelope)) return failure('material_not_submitted', '未找到完全一致的已提交材料，草稿未受理。')
      if (material.sourceVersion !== 1 || material.revises) return failure('stale_version', '此材料的源版本尚不可受理。')
    }
    if (!material.model) return failure('invalid_input', '此材料未选择翻译模型，请重新提交已选模型的材料。')
    if (this.options.isSessionBusy?.(session.id) || this.store.getTranslationHistory(session.id)?.units.some(unit => unit.revisions.some(revision => ['submitting', 'running', 'unknown'].includes(revision.status))) ||
      this.isBusy(session.id)) return failure('busy', '此翻译会话仍有执行中或结果未知的操作。')
    if (!material.unitReference && this.store.getTranslationHistory(session.id)?.units.some(unit => unit.material?.materialId === material.materialId)) return failure('already_admitted', '此材料已建立处理单元，请引用原单元重译。')
    const snapshot = this.terms.getSnapshot(ownerId, material.topicId), selected = request.termReferences.map(ref => snapshot.entries.find(entry => entry.id === ref.id && entry.version === ref.entryVersion))
    if (selected.some(entry => !entry || entry.status !== 'active' || entry.targetLanguage !== material.targetLanguage)) return failure('stale_terms', '所引用术语已变化、未生效或目标语言不符。')
    for (const entry of selected) {
      if (!entry || !this.terms.query(ownerId, material.topicId, { mode: 'normal', sourceLanguage: entry.sourceLanguage,
        targetLanguage: material.targetLanguage, forms: entry.sourceForms }).entries.some(candidate => candidate.id === entry.id && candidate.version === entry.version)) return failure('stale_terms', '术语依据已失效，请重新查询相关术语。')
    }
    return { ok: true, value: { kind: 'normal_prepared', termSnapshot: structuredClone({ ...snapshot, entries: selected.filter(entry => entry !== undefined) }) } }
  }

  accept(ownerId: string, input: NormalTranslationAcceptance): NormalTranslationReply {
    if (this.disposed) return failure('execution_unavailable', '普通翻译业务通道已关闭。')
    const request = parseNormalTranslationAcceptance(input)
    if (request.envelope.material.sourceRef) return failure('requires_batch', 'TXT 原稿已可供准备；整篇分批翻译尚未接入。')
    const signature = JSON.stringify(request)
    const key = JSON.stringify([ownerId, request.operationId]), previous = this.locate(ownerId, request.operationId)
    if (previous) return previous.signature === signature && previous.operation.mainSessionId === ownerId
      ? { ok: true, value: { kind: 'normal_operation', operation: structuredClone(previous.operation), termSnapshot: structuredClone(previous.termSnapshot) } }
      : failure('idempotency_conflict', '此业务操作已用于其他材料或要求，未重复受理。')
    const prepared = this.prepare(ownerId, request)
    if (!prepared.ok || prepared.value.kind !== 'normal_prepared') return prepared
    const envelope = request.envelope, material = envelope.material, session = this.store.getSession(material.translationSessionId)!
    const release = this.retain(ownerId), at = new Date().toISOString()
    if (!this.store.updateTranslationHistory(session.id, history => material.unitReference
      ? acceptUnitRetranslation(history, material.unitReference.unitId, request.operationId, material.sourceVersion, at)
      : appendAdmittedTextUnit(history, envelope, request.operationId, at))) {
      release(); return failure('history_update_failed', '材料记录未完成，草稿保留。')
    }
    const operation: NormalTranslationOperation = { operationId: request.operationId, mainSessionId: ownerId, topicId: material.topicId,
      translationSessionId: session.id, materialId: material.materialId, unitId: material.unitReference?.unitId ?? `unit:${material.materialId}`, sourceVersion: material.sourceVersion,
      draftVersion: material.draftVersion, status: 'accepted', persistence: this.store.getStatus(session.id) === 'saved' ? 'saved' : 'runtime_only' }
    const termSnapshot = prepared.value.termSnapshot
    this.operations.set(key, { signature, operation, termSnapshot, release, callId: null, sequence: 0, text: '', message: undefined, querying: false, updates: new Map() })
    if (material.unitReference) {
      const intent = this.unitRequests.get(JSON.stringify([session.id, material.unitReference.unitId]))
      if (intent) { intent.release?.(); intent.release = undefined; intent.message = '此单元重译已受理。' }
    }
    if (!material.unitReference) this.materials.consumeSubmittedMaterial(envelope)
    this.emit()
    return { ok: true, value: { kind: 'normal_operation', operation: structuredClone(operation), termSnapshot: structuredClone(termSnapshot) } }
  }

  observe(ownerId: string, request: { readonly translationSessionId: string; readonly operationId: string }): NormalTranslationReply {
    const session = this.store.getSession(request.translationSessionId)
    if (this.disposed || !session || session.ownerId !== ownerId || this.store.isSessionDeleted(session.id)) return failure('out_of_scope', '业务操作不属于当前主会话或已删除。')
    const item = this.locate(ownerId, request.operationId)
    return { ok: true, value: { kind: 'normal_observed', operation: item?.operation.translationSessionId === session.id ? structuredClone(item.operation) : null } }
  }

  update(ownerId: string, input: NormalTranslationUpdate): NormalTranslationReply {
    const update = parseNormalTranslationUpdate(input), item = this.locate(ownerId, update.operationId)
    if (this.disposed || !item) return failure('operation_not_found', '此业务操作未在当前会话受理，结果未采用。')
    const op = item.operation, session = this.store.getSession(op.translationSessionId)
    if (update.mainSessionId !== ownerId || update.translationSessionId !== op.translationSessionId || update.unitId !== op.unitId ||
      update.sourceVersion !== op.sourceVersion || !session || session.ownerId !== ownerId || session.topicId !== op.topicId || this.store.isSessionDeleted(session.id)) return failure('identity_mismatch', '普通翻译结果归属或源版本不一致，未采用。')
    const signature = JSON.stringify(update)
    const reply = (): NormalTranslationReply => ({ ok: true, value: { kind: 'normal_updated', operation: structuredClone(item.operation), callId: update.callId, sequence: update.sequence } })
    if (update.sequence <= item.sequence) return !item.updates.has(update.sequence) || item.updates.get(update.sequence) === signature ? reply() : failure('idempotency_conflict', '同一执行事件不能更换内容。')
    if (update.sequence !== item.sequence + 1) { this.unknown(item, '流式回执尚未齐全，请查询原操作；未自动重发。'); return failure('sequence_gap', '执行事件缺失，请查询原操作。') }
    if (item.callId !== null && item.callId !== update.callId) return failure('identity_mismatch', '模型调用身份不一致，未采用。')
    const history = this.store.getTranslationHistory(session.id)!, unit = history.units.find(unit => unit.id === op.unitId)
    if (!unit || !unit.sourceVersions.some(source => source.version === update.sourceVersion)) return failure('stale_version', '处理单元的源记录已不可用。')
    const existing = unit.revisions.find(revision => revision.id === update.callId)
    const text = item.text + update.textDelta, at = new Date().toISOString()
    if (['completed', 'failed', 'cancelled'].includes(op.status) && update.status !== op.status) return failure('invalid_state', '操作已经结束，迟到状态未采用。')
    if (update.status === 'completed' && !text.trim()) return failure('incomplete_result', '空输出不能记为完成。')
    const metadata = update.metadata ?? existing?.callRecord ?? null
    if (update.callId !== null && !existing && (update.status !== 'running' || update.textDelta !== '' || !metadata)) return failure('invalid_metadata', '新模型调用须先记录实际开始回执，未伪造调用。')
    if (metadata && !this.matchesCall(item, metadata, existing?.callRecord ?? null)) return failure('invalid_metadata', '实际调用的要求、术语或模型记录与受理事实不符。')
    const message = update.error?.message ?? (update.status === 'unknown' ? '执行结果未知，请查询本轮状态；未自动重发。' : null)
    const updated = this.store.updateTranslationHistory(session.id, current => {
      const next = update.callId === null ? current : existing
        ? updateTextRevision(current, unit.id, update.callId, { status: update.status, text, callRecord: metadata, message, updatedAt: at })
        : appendTextRevision(current, unit.id, { id: update.callId, operationId: op.operationId,
          model: item.signature ? (JSON.parse(item.signature) as NormalTranslationAcceptance).envelope.material.model : metadata ? {
            provider: metadata.model.provider, model: metadata.model.model, ...(metadata.model.reasoningEffort === null ? {} : { reasoningEffort: metadata.model.reasoningEffort }),
          } : unit.material?.model ?? null, draftVersion: op.draftVersion,
          sourceVersion: op.sourceVersion, createdAt: at, updatedAt: at, accepted: true, status: update.status, text, callRecord: metadata, message })
      return appendTranslationEvent(next, { id: `text-event:${next.events.length + 1}`, type: 'operation.updated', at, unitId: unit.id,
        revisionId: update.callId, operationId: op.operationId, status: update.status, reason: null, normalSequence: update.sequence, sourceVersion: op.sourceVersion })
    })
    if (!updated) { this.unknown(item, '译文记录未更新，请查询原操作；未自动重发。'); return failure('history_update_failed', '译文记录未更新。') }
    item.callId = update.callId; item.sequence = update.sequence; item.text = text; item.message = message ?? undefined; item.updates.set(update.sequence, signature)
    item.operation = { ...op, status: update.status, persistence: this.store.getStatus(session.id) === 'saved' ? 'saved' : 'runtime_only' }
    if (['completed', 'failed', 'cancelled', 'unknown'].includes(update.status)) {
      // TopicBridge must send this short receipt before closing its last stream lease.
      const release = item.release; item.release = undefined; if (release) setTimeout(release, 0)
    }
    this.emit(); return reply()
  }

  private matchesCall(item: AcceptedOperation, metadata: TranslationCallMetadata, previous: TranslationCallMetadata | null): boolean {
    if (metadata.promptVersion !== 'normal-text-v1' || !metadata.context) return false
    if (previous) return JSON.stringify({ ...metadata, usage: null }) === JSON.stringify({ ...previous, usage: null })
    if (!item.signature) return true // A restored history already owns its saved call context.
    const request = JSON.parse(item.signature) as NormalTranslationAcceptance, model = request.envelope.material.model!
    const terms = item.termSnapshot.entries.map(entry => ({ id: entry.id, entryVersion: entry.version, sourceForms: entry.sourceForms,
      aliases: entry.aliases, sense: entry.sense, preferred: entry.preferred, forbidden: entry.forbidden, userFixed: entry.origin === 'user_explicit' }))
    return metadata.model.provider === model.provider && metadata.model.model === model.model && (model.reasoningEffort === undefined || metadata.model.reasoningEffort === model.reasoningEffort) &&
      JSON.stringify(metadata.context) === JSON.stringify({ organizedRequirements: request.organizedRequirements, terms })
  }

  private locate(ownerId: string, operationId: string): AcceptedOperation | undefined {
    const key = this.key(ownerId, operationId), known = this.operations.get(key)
    if (known) return known
    for (const session of this.store.getAvailableSessions(ownerId)) {
      const history = this.store.getTranslationHistory(session.id)
      const event = [...history?.events ?? []].reverse().find(event => event.operationId === operationId)
      const unit = history?.units.find(unit => unit.id === event?.unitId), material = unit?.material
      const accepted = history?.events.find(event => event.operationId === operationId && ['operation.accepted', 'operation.retranslation_accepted'].includes(event.type) && event.revisionId === null)
      if (!unit || event?.type === 'source.corrected' || (material && material.mainSessionId !== ownerId) || this.store.isSessionDeleted(session.id)) continue
      const revision = [...unit.revisions].reverse().find(revision => revision.operationId === operationId)
      if (!accepted && revision?.callRecord?.promptVersion !== 'normal-text-v1') continue
      const receipt = [...history!.events].reverse().find(event => event.operationId === operationId && event.normalSequence !== undefined)
      const state = revision?.status ?? event?.status
      const item: AcceptedOperation = { signature: '', operation: { operationId, mainSessionId: ownerId, topicId: session.topicId,
        translationSessionId: session.id, materialId: material?.materialId ?? unit.id, unitId: unit.id, sourceVersion: revision?.sourceVersion ?? accepted?.sourceVersion ?? 1,
        draftVersion: material?.draftVersion ?? 1, status: ['completed', 'failed', 'cancelled'].includes(state ?? '') ? state as 'completed' | 'failed' | 'cancelled' : 'unknown',
        persistence: this.store.getStatus(session.id) === 'saved' ? 'saved' : 'runtime_only' }, termSnapshot: { ...this.terms.getSnapshot(ownerId, session.topicId), entries: [] },
        release: undefined, callId: revision?.id ?? null, sequence: receipt?.normalSequence ?? 0, text: revision?.text ?? '', message: revision?.message ??
          (['completed', 'failed', 'cancelled'].includes(state ?? '') ? undefined : '上次普通执行已中断，可查询原操作；未自动重发。'), querying: false, updates: new Map() }
      this.operations.set(key, item); return item
    }
    return undefined
  }
  getUnitStatus(sessionId: string, unitId: string): { readonly operationId: string; readonly status: NormalTranslationOperation['status']; readonly message: string | undefined; readonly querying: boolean } | undefined {
    const session = this.store.getSession(sessionId), history = this.store.getTranslationHistory(sessionId)
    const event = [...history?.events ?? []].reverse().find(event => event.unitId === unitId && event.operationId !== null && event.type !== 'final.selected' && event.type !== 'revision.manual_saved' && event.type !== 'source.corrected')
    const item = session && event?.operationId ? this.locate(session.ownerId, event.operationId) : undefined
    return item ? { operationId: item.operation.operationId, status: item.operation.status, message: item.message, querying: item.querying } : undefined
  }
  isBusy(sessionId: string): boolean {
    const session = this.store.getSession(sessionId)
    if (session) for (const event of this.store.getTranslationHistory(sessionId)?.events ?? []) if (event.operationId !== null &&
      ['operation.accepted', 'operation.retranslation_accepted'].includes(event.type) && event.revisionId === null) this.locate(session.ownerId, event.operationId)
    return [...this.operations.values()].some(item => item.operation.translationSessionId === sessionId && ['accepted', 'running', 'unknown'].includes(item.operation.status))
  }
  private unknown(item: AcceptedOperation, message: string): void {
    if (!['accepted', 'running', 'unknown'].includes(item.operation.status)) return
    const at = new Date().toISOString(), op = item.operation
    item.operation = { ...op, status: 'unknown' }; item.message = message
    if (item.callId) this.store.updateTranslationHistory(op.translationSessionId, history => updateTextRevision(history, op.unitId, item.callId!, { status: 'unknown', message, updatedAt: at }))
    else this.store.updateTranslationHistory(op.translationSessionId, history => appendTranslationEvent(history, {
      id: `text-event:${history.events.length + 1}`, type: 'operation.updated', at, unitId: op.unitId, revisionId: null, operationId: op.operationId, status: 'unknown', reason: null, sourceVersion: op.sourceVersion,
    }))
    this.emit()
  }
  async query(sessionId: string, unitId: string): Promise<void> { await this.request(sessionId, unitId, 'status') }
  async cancel(sessionId: string, unitId: string): Promise<void> { await this.request(sessionId, unitId, 'cancel') }
  getRetranslationStatus(sessionId: string, unitId: string): { readonly pending: boolean; readonly message: string } | undefined {
    return this.unitRequests.get(JSON.stringify([sessionId, unitId]))
  }
  retranslateBlockedReason(sessionId: string, unitId: string): string | undefined {
    const session = this.store.getSession(sessionId), unit = this.store.getTranslationHistory(sessionId)?.units.find(unit => unit.id === unitId)
    if (!session || session.mode !== 'normal' || !unit || this.store.isSessionDeleted(sessionId)) return '普通单元已不可用。'
    if (session.archivedAt !== null) return '请先恢复归档会话。'
    if (!session.model) return '请先选择本次翻译模型。'
    if (this.store.getStatus(sessionId) === 'conflict') return '本地记录已变化，请核对当前副本。'
    if (this.isBusy(sessionId)) return '当前会话仍有执行中或未知操作，请先查询或取消。'
    if (this.getRetranslationStatus(sessionId, unitId)?.pending) return '正在发送重译意图。'
    return undefined
  }
  async retranslate(sessionId: string, unitId: string): Promise<void> {
    if (this.disposed || this.retranslateBlockedReason(sessionId, unitId)) return
    const session = this.store.getSession(sessionId)!, unit = this.store.getTranslationHistory(sessionId)!.units.find(unit => unit.id === unitId)!
    const key = JSON.stringify([sessionId, unitId]), old = this.unitRequests.get(key), operationId = old?.outcome === 'unknown' ? old.operationId : `unit-intent:${crypto.randomUUID()}`
    const request: NormalTranslationUnitRequest = { operationId, target: { kind: 'unit', mainSessionId: session.ownerId, translationSessionId: sessionId, unitId, sourceVersion: unit.sourceVersion } }
    const release = this.retain(session.ownerId)
    old?.release?.()
    const item = { operationId, pending: true, outcome: 'pending' as 'pending' | 'submitted' | 'failed' | 'unknown', message: '正在发送重译意图…', release: release as (() => void) | undefined }; this.unitRequests.set(key, item); this.emit()
    let handoff = false
    try {
      if (!this.options.publishUnit?.(session.ownerId, session.id, unit.id)) throw new Error('历史单元未能供主模型读取。')
      const port = typeof this.options.remote === 'function' ? await this.options.remote() : this.options.remote
      if (!port?.requestUnit) throw new Error('宿主尚未提供普通重译入口。')
      handoff = true
      const response = await port.requestUnit(request) as { ok?: boolean; value?: { ok?: boolean; value?: { operationId?: string; target?: unknown; status?: string }; error?: { message?: string } } }
      if (response.value?.ok === false) handoff = false
      if (response.ok !== true || response.value?.ok !== true) throw new Error(response.value?.error?.message ?? '重译意图未确认。')
      const receipt = response.value.value
      if (receipt?.operationId !== operationId || receipt.status !== 'submitted' || JSON.stringify(receipt.target) !== JSON.stringify(request.target)) throw new Error('重译意图回执身份无效。')
      item.outcome = 'submitted'; item.message = '已向主模型发送此单元重译意图，等待业务受理。'
    } catch (error) { item.outcome = handoff ? 'unknown' : 'failed'; item.message = `${handoff ? '发送状态未知' : '发送失败'}：${error instanceof Error ? error.message : '请核对主会话。'} 未自动重发。` }
    finally { item.pending = false; if (!handoff) { item.release?.(); item.release = undefined }; this.emit() }
  }
  private async request(sessionId: string, unitId: string, method: 'status' | 'cancel'): Promise<void> {
    const status = this.getUnitStatus(sessionId, unitId), session = this.store.getSession(sessionId)
    if (this.disposed || !status || !session) return
    const item = this.locate(session.ownerId, status.operationId)!
    if (item.querying) return
    item.querying = true; item.release ??= this.retain(session.ownerId); this.emit()
    try {
      const port = typeof this.options.remote === 'function' ? await this.options.remote() : this.options.remote
      if (!port) throw new Error('普通翻译服务尚未就绪。')
      let more = true, action = method
      while (more && !this.disposed) {
        let timer: ReturnType<typeof setTimeout> | undefined
        const after = item.sequence, raw = await Promise.race([port[action]({ mainSessionId: session.ownerId, translationSessionId: sessionId, operationId: status.operationId, afterSequence: after }),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('普通执行状态查询超时，请查询原操作；未自动重发。')), 15000) })]).finally(() => clearTimeout(timer)) as { ok?: boolean; value?: { ok?: boolean; value?: unknown; error?: { message?: string } } }
        if (this.disposed) return
        action = 'status'
        if (raw?.ok !== true || raw.value?.ok !== true) throw new Error(raw?.value?.error?.message ?? '未取得普通执行状态，未自动重发。')
        const job = parseNormalTranslationJob(raw.value.value)
        if (!job.operation || job.operation.mainSessionId !== session.ownerId || job.operation.operationId !== status.operationId || job.operation.translationSessionId !== sessionId || job.operation.unitId !== unitId) throw new Error(job.error?.message ?? '普通执行状态身份不一致或已不可查询。')
        for (const update of job.updates) { const result = this.update(session.ownerId, update); if (!result.ok) throw new Error(result.error.message) }
        if (job.lastSequence > item.sequence && !job.more) throw new Error('执行状态仍缺少回执，请再次查询原操作。')
        more = job.more
        if (more && item.sequence <= after) throw new Error('状态分页未推进，请再次查询原操作。')
        if (!job.updates.length && job.operation.status === 'unknown') this.unknown(item, job.error?.message ?? '执行结果未知，请保留原操作查询。')
        else if (!more && item.operation.status === 'unknown' && job.lastSequence === item.sequence && job.callId === item.callId) {
          const operation = job.operation, at = new Date().toISOString()
          item.operation = { ...item.operation, status: operation.status }; item.message = job.error?.message
          const restoredStatus = operation.status
          if (item.callId && restoredStatus !== 'accepted') this.store.updateTranslationHistory(sessionId, history => updateTextRevision(history, unitId, item.callId!, {
            status: restoredStatus, message: job.error?.message ?? null, updatedAt: at,
          }))
        }
      }
    } catch (error) { this.unknown(item, error instanceof Error ? error.message : '普通执行查询未完成。') }
    finally { item.querying = false; if (!['accepted', 'running'].includes(item.operation.status)) { item.release?.(); item.release = undefined }; this.emit() }
  }
  reset(): void { for (const item of this.operations.values()) if (['accepted', 'running'].includes(item.operation.status)) this.unknown(item, '连接已重置，请查询原操作；未自动重发。') }
  dispose(): void {
    this.disposed = true; this.stopBridge?.()
    for (const item of this.operations.values()) item.release?.()
    for (const item of this.unitRequests.values()) item.release?.()
    this.operations.clear(); this.unitSnapshots.clear(); this.unitRequests.clear(); this.listeners.clear()
  }
}
