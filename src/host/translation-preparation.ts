import {
  parseTranslationPreparationPrepare, parseTranslationPreparationSet, parseTranslationPreparationQuery, parseTranslationPreparationRead,
  type AnalysisResult, type TranslationPreparationPrepare, type TranslationPreparationSet,
} from '../shared/translation-preparation.js'
import type { TranslationMaterialEnvelope } from '../shared/translation-material.js'
import { MAX_TOPIC_BRIDGE_REPLY_BYTES, type TopicBridgeCommand, type TopicBridgeValue } from '../shared/topic-bridge.js'
import type { TopicHostContext, TopicToolsService, ToolExecution } from './topic-tools.js'
import type { TranslationMaterialsService } from './translation-materials.js'
import type { TerminologyAnalysisService } from './terminology-analysis.js'

type Envelope = Extract<TranslationMaterialEnvelope, { kind: 'material' }>
function failure(code: string, message: string, stage: string): AnalysisResult<never> { return { ok: false, error: { code, message, stage } } }

/** Host proves delivered material and analysis; the sole Client bridge commits preparations. */
export class TranslationPreparationService {
  private disposed = false
  constructor(readonly ctx: TopicHostContext) {}
  private get topics(): TopicToolsService | undefined { return this.ctx.get?.('translationTopics') as TopicToolsService | undefined }
  private authorized(ownerId: string, exec: ToolExecution): AnalysisResult<true> {
    if (this.disposed || !this.topics?.ownsAgent(ownerId, exec.agent)) return failure('scope_mismatch', '准备操作不属于已连接的实际主 Agent。', 'authorize_preparation')
    if (this.topics.protocolFor(ownerId) !== 2) return failure('preparation_unavailable', '准备记录需要当前唯一主题桥的 v2 连接。', 'authorize_preparation')
    exec.signal.throwIfAborted()
    return { ok: true, value: true }
  }
  private material(request: TranslationPreparationPrepare | TranslationPreparationSet, exec: ToolExecution): AnalysisResult<Envelope> {
    const authorization = this.authorized(request.target.mainSessionId, exec)
    if (!authorization.ok) return authorization
    const materials = this.ctx.get?.('translationMaterials') as TranslationMaterialsService | undefined
    return materials?.deliveredForAgent(request.target, exec.agent!) ?? failure('unavailable', '固定材料服务尚未就绪。', 'authorize_preparation')
  }
  private async request(ownerId: string, command: TopicBridgeCommand, expected: TopicBridgeValue['kind'], exec: ToolExecution): Promise<AnalysisResult<unknown>> {
    try {
      if (new TextEncoder().encode(JSON.stringify({ kind: 'request', requestId: 'x'.repeat(36), mainSessionId: ownerId, callId: exec.callId, command })).byteLength > MAX_TOPIC_BRIDGE_REPLY_BYTES) return failure('request_too_large', '完整准备传输包超过 196608 字节，请调整分析或任务范围；候选未截断、准备未登记。', 'preparation_budget')
      const value = await this.topics!.requestOwned(ownerId, command, exec)
      if (value.kind !== expected) return failure('invalid_reply', '准备记录回执类型不一致。', 'preparation_bridge')
      if (command.kind === 'preparation_prepare' || command.kind === 'preparation_set' || command.kind === 'preparation_status' || command.kind === 'preparation_read') {
        const response = value.kind === 'preparation_receipt' ? value.receipt : value.kind === 'preparation_page' ? value.page : undefined
        if (!response || response.preparationId !== command.request.preparationId || JSON.stringify(response.target) !== JSON.stringify(command.request.target)) return failure('invalid_reply', '准备回执与请求的固定材料或标识不一致。', 'preparation_bridge')
        const version = command.kind === 'preparation_prepare' ? 1 : command.kind === 'preparation_set' ? command.request.expectedVersion + 1 : command.request.version
        if (response.version !== version) return failure('invalid_reply', '准备回执版本与明确操作不一致。', 'preparation_bridge')
        if ('scope' in response && (response.scope.ownerId !== ownerId || response.scope.mainSessionId !== ownerId || response.sourceVersion !== command.request.target.sourceVersion)) return failure('invalid_reply', '准备回执所属会话或源版本不一致。', 'preparation_bridge')
        if (command.kind === 'preparation_read' && 'section' in response && response.section !== command.request.section) return failure('invalid_reply', '准备分页区段与请求不一致。', 'preparation_bridge')
      }
      return { ok: true, value: 'receipt' in value ? value.receipt : 'page' in value ? value.page : value }
    } catch (error) {
      const known = error as { readonly code?: string; readonly message?: string }
      return failure(known.code ?? 'bridge_failed', known.message ?? '准备记录操作未确认，请查询原准备版本。', 'preparation_bridge')
    }
  }
  async prepare(args: unknown, exec: ToolExecution): Promise<AnalysisResult<unknown>> {
    let request: TranslationPreparationPrepare
    try { request = parseTranslationPreparationPrepare(args) } catch { return failure('invalid_input', '准备创建参数无效。', 'prepare_preparation') }
    const material = this.material(request, exec)
    if (!material.ok) return material
    const analysis = this.ctx.get?.('translationAnalysis') as TerminologyAnalysisService | undefined
    const facts = analysis?.preparationFacts({ target: request.target, analysisId: request.analysisId, version: request.analysisVersion }, exec)
    if (!facts) return failure('unavailable', '真实术语分析服务尚未就绪。', 'prepare_preparation')
    if (!facts.ok) return facts
    return this.request(request.target.mainSessionId, { kind: 'preparation_prepare', request, envelope: material.value, analysis: facts.value }, 'preparation_receipt', exec)
  }
  async set(args: unknown, exec: ToolExecution): Promise<AnalysisResult<unknown>> {
    let request: TranslationPreparationSet
    try { request = parseTranslationPreparationSet(args) } catch { return failure('invalid_input', '准备采用参数无效。', 'set_preparation') }
    const material = this.material(request, exec)
    if (!material.ok) return material
    return this.request(request.target.mainSessionId, { kind: 'preparation_set', request, envelope: material.value }, 'preparation_receipt', exec)
  }
  async status(args: unknown, exec: ToolExecution): Promise<AnalysisResult<unknown>> {
    let request: ReturnType<typeof parseTranslationPreparationQuery>
    try { request = parseTranslationPreparationQuery(args) } catch { return failure('invalid_input', '准备状态查询参数无效。', 'status_preparation') }
    const authorized = this.authorized(request.target.mainSessionId, exec)
    if (!authorized.ok) return authorized
    return this.request(request.target.mainSessionId, { kind: 'preparation_status', request }, 'preparation_receipt', exec)
  }
  async read(args: unknown, exec: ToolExecution): Promise<AnalysisResult<unknown>> {
    let request: ReturnType<typeof parseTranslationPreparationRead>
    try { request = parseTranslationPreparationRead(args) } catch { return failure('invalid_input', '准备分页查询参数无效。', 'read_preparation') }
    const authorized = this.authorized(request.target.mainSessionId, exec)
    if (!authorized.ok) return authorized
    return this.request(request.target.mainSessionId, { kind: 'preparation_read', request }, 'preparation_page', exec)
  }
  dispose(): void { this.disposed = true }
}

export function installTranslationPreparation(ctx: TopicHostContext): TranslationPreparationService {
  const service = new TranslationPreparationService(ctx)
  ctx.provide('translationPreparation', service)
  ctx.effect?.(() => () => service.dispose(), 'translation preparation lifetime')
  return service
}
