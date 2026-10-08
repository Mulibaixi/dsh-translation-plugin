import { parseNormalTranslationAcceptance, type NormalTranslationAcceptance, type NormalTranslationOperation } from '../shared/normal-translation.js'
import type { TopicBridgeValue } from '../shared/topic-bridge.js'
import type { TopicTermSnapshot } from '../memory/topic-terms.js'
import { appendAdmittedTextUnit } from './translation-history.js'
import type { SessionStore } from './session-store.js'
import type { MaterialSubmissionsClient } from './material-submissions.js'
import type { TopicBridgeTermsPort } from './topic-bridge.js'

export type NormalTranslationReply = { readonly ok: true; readonly value: Extract<TopicBridgeValue, { kind: 'normal_operation' }> }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
interface AcceptedOperation {
  readonly signature: string
  readonly operation: NormalTranslationOperation
  readonly termSnapshot: TopicTermSnapshot
  readonly release: () => void
}
const failure = (code: string, message: string): NormalTranslationReply => ({ ok: false, error: { code, message } })

/** Admission facts live in SessionStore; this runtime index only correlates short bridge receipts. */
export class NormalTranslationClient {
  private readonly operations = new Map<string, AcceptedOperation>()
  private disposed = false
  constructor(private readonly store: SessionStore, private readonly materials: MaterialSubmissionsClient,
    private readonly terms: TopicBridgeTermsPort, private readonly retain: (ownerId: string) => () => void,
    private readonly options: { readonly isSessionBusy?: (sessionId: string) => boolean } = {}) {}

  accept(ownerId: string, input: NormalTranslationAcceptance): NormalTranslationReply {
    if (this.disposed) return failure('execution_unavailable', '普通翻译业务通道已关闭。')
    const request = parseNormalTranslationAcceptance(input), signature = JSON.stringify(request)
    const key = JSON.stringify([ownerId, request.operationId]), previous = this.operations.get(key)
    if (previous) return previous.signature === signature && previous.operation.mainSessionId === ownerId
      ? { ok: true, value: { kind: 'normal_operation', operation: structuredClone(previous.operation), termSnapshot: structuredClone(previous.termSnapshot) } }
      : failure('idempotency_conflict', '此业务操作已用于其他材料或要求，未重复受理。')
    const envelope = request.envelope, material = envelope.material, session = this.store.getSession(material.translationSessionId)
    if (envelope.mainSessionId !== ownerId || envelope.ownerId !== ownerId || !session || session.ownerId !== ownerId || session.topicId !== material.topicId ||
      this.store.isSessionDeleted(session.id) || !this.store.getTopics(ownerId).some(topic => topic.id === material.topicId)) return failure('out_of_scope', '材料不属于当前主会话、主题或翻译会话。')
    if (session.mode !== 'normal' || session.archivedAt !== null) return failure('invalid_state', '普通翻译会话已不可执行，请恢复会话后重新提交材料。')
    if (this.store.getStatus(session.id) === 'conflict') return failure('stale_version', '本地历史已变化，请先核对当前副本。')
    if (!this.materials.resolveSubmittedMaterial(envelope)) return failure('material_not_submitted', '未找到完全一致的已提交材料，草稿未受理。')
    if (material.sourceVersion !== 1 || material.unitReference || material.revises) return failure('stale_version', '此材料的源版本或处理单元引用尚不可受理。')
    if (!material.model) return failure('invalid_input', '此材料未选择翻译模型，请重新提交已选模型的材料。')
    if (this.options.isSessionBusy?.(session.id) || this.store.getTranslationHistory(session.id)?.units.some(unit => unit.revisions.some(revision => ['submitting', 'running', 'unknown'].includes(revision.status))) ||
      [...this.operations.values()].some(item => item.operation.translationSessionId === session.id &&
      ['accepted', 'running', 'unknown'].includes(item.operation.status))) return failure('busy', '此翻译会话仍有执行中或结果未知的操作。')
    if (this.store.getTranslationHistory(session.id)?.units.some(unit => unit.material?.materialId === material.materialId)) return failure('already_admitted', '此材料已建立处理单元，请引用原单元重译。')
    const snapshot = this.terms.getSnapshot(ownerId, material.topicId), selected = request.termReferences.map(ref => snapshot.entries.find(entry => entry.id === ref.id && entry.version === ref.entryVersion))
    if (selected.some(entry => !entry || entry.status !== 'active' || entry.targetLanguage !== material.targetLanguage)) return failure('stale_terms', '所引用术语已变化、未生效或目标语言不符。')
    for (const entry of selected) {
      if (!entry || !this.terms.query(ownerId, material.topicId, { mode: 'normal', sourceLanguage: entry.sourceLanguage,
        targetLanguage: material.targetLanguage, forms: entry.sourceForms }).entries.some(candidate => candidate.id === entry.id && candidate.version === entry.version)) return failure('stale_terms', '术语依据已失效，请重新查询相关术语。')
    }
    const release = this.retain(ownerId), at = new Date().toISOString()
    if (!this.store.updateTranslationHistory(session.id, history => appendAdmittedTextUnit(history, envelope, request.operationId, at))) {
      release(); return failure('history_update_failed', '材料记录未完成，草稿保留。')
    }
    const operation: NormalTranslationOperation = { operationId: request.operationId, mainSessionId: ownerId, topicId: material.topicId,
      translationSessionId: session.id, materialId: material.materialId, unitId: `unit:${material.materialId}`, sourceVersion: material.sourceVersion,
      draftVersion: material.draftVersion, status: 'accepted', persistence: this.store.getStatus(session.id) === 'saved' ? 'saved' : 'runtime_only' }
    const termSnapshot: TopicTermSnapshot = { ...snapshot, entries: selected.filter(entry => entry !== undefined) }
    this.operations.set(key, { signature, operation, termSnapshot: structuredClone(termSnapshot), release })
    this.materials.consumeSubmittedMaterial(envelope)
    return { ok: true, value: { kind: 'normal_operation', operation: structuredClone(operation), termSnapshot: structuredClone(termSnapshot) } }
  }
  dispose(): void {
    this.disposed = true
    for (const item of this.operations.values()) item.release()
    this.operations.clear()
  }
}
