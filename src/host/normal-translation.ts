import { parseNormalTranslationExecute, type NormalTranslationExecute } from '../shared/normal-translation.js'
import type { TopicBridgeValue } from '../shared/topic-bridge.js'
import type { TopicHostContext, TopicToolsService, ToolExecution } from './topic-tools.js'
import type { TranslationMaterialsService } from './translation-materials.js'

type Accepted = Extract<TopicBridgeValue, { kind: 'normal_operation' }>
interface Admission {
  readonly signature: string
  readonly sessionId: string
  readonly result: Promise<Accepted>
}
function rejected(code: string, message: string, stage: string): Error { return Object.assign(new Error(message), { code, stage }) }

/** Transient admission receipts only. All units, sources and revisions belong to the Client. */
export class NormalTranslationService {
  private readonly admissions = new Map<string, Admission>()
  private readonly activeSessions = new Set<string>()
  private disposed = false
  constructor(readonly ctx: TopicHostContext) {}
  private get topics(): TopicToolsService { return this.ctx.get?.('translationTopics') as TopicToolsService }
  private get materials(): TranslationMaterialsService { return this.ctx.get?.('translationMaterials') as TranslationMaterialsService }
  private owned(request: NormalTranslationExecute, exec: ToolExecution): void {
    if (this.disposed || !this.topics?.ownsAgent(request.target.mainSessionId, exec.agent)) throw rejected('scope_mismatch', '普通翻译操作不属于已连接的主 Agent。', 'authorize')
    exec.signal.throwIfAborted()
  }
  async execute(input: unknown, exec: ToolExecution): Promise<Accepted> {
    const request = parseNormalTranslationExecute(input)
    this.owned(request, exec)
    // The foundation cannot consume a draft before an execution implementation is available.
    throw rejected('execution_unavailable', '普通翻译执行尚未接入；材料保留，可继续讨论。', 'prepare')
  }
  /** Host-only foundation. The executor enters this method after successful model preparation. */
  acceptPrepared(input: NormalTranslationExecute, exec: ToolExecution): Promise<Accepted> {
    const request = parseNormalTranslationExecute(input)
    this.owned(request, exec)
    const identity = JSON.stringify([request.target.mainSessionId, request.operationId]), signature = JSON.stringify(request)
    const previous = this.admissions.get(identity)
    if (previous) {
      if (previous.signature !== signature) throw rejected('idempotency_conflict', '同一业务操作 ID 不能更换材料、版本或要求。', 'accept')
      return previous.result.then(result => structuredClone(result))
    }
    const source = this.materials?.deliveredForAgent(request.target, exec.agent!)
    if (!source) throw rejected('execution_unavailable', '材料服务尚未就绪。', 'resolve_material')
    if (!source.ok) throw rejected(source.error.code, source.error.message, source.error.stage)
    if (source.value.material.unitReference || source.value.material.revises) throw rejected('unsupported_target', '已有单元的原文修改需使用专门纠错操作。', 'resolve_material')
    const sessionId = JSON.stringify([request.target.mainSessionId, source.value.material.translationSessionId])
    if (this.activeSessions.has(sessionId)) throw rejected('busy', '此普通翻译会话仍有未结算操作。', 'accept')
    this.activeSessions.add(sessionId)
    const result = Promise.resolve().then(async (): Promise<Accepted> => {
      const value = await this.topics.requestOwned(request.target.mainSessionId, { kind: 'normal_accept', envelope: source.value,
        operationId: request.operationId, organizedRequirements: request.organizedRequirements, termReferences: request.termReferences }, exec)
      if (value.kind !== 'normal_operation' || value.operation.operationId !== request.operationId || value.operation.mainSessionId !== request.target.mainSessionId ||
        value.operation.materialId !== request.target.materialId || value.operation.sourceVersion !== request.target.sourceVersion ||
        value.operation.translationSessionId !== source.value.material.translationSessionId || value.operation.topicId !== source.value.material.topicId ||
        value.operation.draftVersion !== source.value.material.draftVersion) throw rejected('invalid_reply', '普通翻译业务回执身份不一致。', 'accept')
      if (value.termSnapshot.entries.length !== request.termReferences.length || request.termReferences.some(ref =>
        !value.termSnapshot.entries.some(entry => entry.id === ref.id && entry.version === ref.entryVersion && entry.targetLanguage === source.value.material.targetLanguage))) throw rejected('invalid_reply', '普通翻译术语回执与指定版本不一致。', 'accept')
      return structuredClone(value)
    }).catch(error => {
      // Unknown acceptance stays reserved and cannot be dispatched again by a repeated tool call.
      if (!['outcome_unknown', 'invalid_reply'].includes((error as { code?: string }).code ?? '')) this.activeSessions.delete(sessionId)
      throw error
    })
    this.admissions.set(identity, { signature, sessionId, result })
    return result.then(value => structuredClone(value))
  }
  dispose(): void { this.disposed = true; this.admissions.clear(); this.activeSessions.clear() }
}
export function installNormalTranslation(ctx: TopicHostContext): NormalTranslationService {
  const service = new NormalTranslationService(ctx)
  ctx.provide('translationNormal', service)
  ctx.effect?.(() => () => service.dispose(), 'normal translation lifetime')
  return service
}
