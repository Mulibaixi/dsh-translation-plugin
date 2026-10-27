import { diagnosticSpan, type DiagnosticContext } from './diagnostics.js'
import type { FrozenReferenceContext } from '../shared/reference-memory.js'
import type { ModelSelection } from '../shared/contracts.js'
import type { TextCapabilityEvidence, TextExecutionAdapter, TextExecutionEvent, TextExecutionPacket } from '../shared/domain-contracts.js'
import type { DirectHistoryContext } from '../shared/direct-history-context.js'
import { NORMAL_TRANSLATION_DIRECT_PROMPT_VERSION, NORMAL_TRANSLATION_EXCHANGE_PROMPT_VERSION, NORMAL_TRANSLATION_PROMPT_VERSION, TRANSLATION_PROMPT_VERSION,
  reconstructTranslationContext, reconstructNormalExchangeTranslationContext, reconstructDirectTranslationContext, reconstructNormalTranslationContext,
  type NormalTranslationContext, type TranslationCallMetadata } from '../shared/translation-call.js'
import { parseRequestContextInput, type RequestContextInput } from '../shared/request-context.js'
import type { NormalTranslationResolution } from '../shared/normal-translation-v2.js'
import type { TranslationMaterialRoute } from '../shared/translation-material.js'
import { DOCUMENT_TRANSLATION_PROMPT_VERSION, DOCUMENT_TRANSLATION_CONTEXT_PROMPT_VERSION, reconstructDocumentSystemPrompt, type DocumentPreparedCapacity, type DocumentTranslationPrompt } from '../shared/document-planning.js'
import type { DocumentCallRecord } from '../shared/translation-batch.js'
export { QUICK_SYSTEM_PROMPT } from '../shared/translation-call.js'

/** Narrow views of the 0.2.0-rc.2 public runtime, checked against the installed packages. */
export interface DshPreparedCall {
  readonly config: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string; readonly maxTokens?: number }
  readonly adapterDefaults: Record<string, true>
  readonly context?: { readonly contextWindow: number }
  /** Public rc.2 exact-route evidence that the adapter handles tool declarations. */
  readonly toolUpdate?: 'in-history' | 'addition-only'
  stream(options: Record<string, unknown>): AsyncIterable<Record<string, unknown>>
}
export interface DshDetachedSession {
  append(type: string, data: unknown, options?: { surfaceOp: 'append' }): unknown
  deriveMessages(): readonly unknown[]
}
export interface DshExecutionContext extends DiagnosticContext {
  readonly llm?: {
    listModels(provider: string): Promise<readonly { provider: string; id: string }[]>
    resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{ provider: string; id: string; reasoning?: { efforts: readonly { id: string }[]; defaultEffort?: string } }>
    prepareCall(config: Record<string, unknown>, signal?: AbortSignal): Promise<DshPreparedCall>
  }
  readonly sessions?: { prepare(id: string): DshDetachedSession }
  /** Native Cordis get() reads optional services without requiring inject. */
  get?(name: string): unknown
  readonly baseUrl?: string
  readonly loader?: { readonly internal?: { import(specifier: string, parentUrl: string, attributes: Record<string, never>): Promise<unknown> } }
}
export interface DshLlmHelpers {
  createSystemMessage(text: string): unknown
  createUserMessage(input: unknown): unknown
  createAssistantMessage(input: unknown): unknown
  AssistantStreamAccumulator: new () => { push(value: { time: number; chunk: unknown }): unknown; snapshot(): readonly unknown[] }
  BlockAssembler: new () => { push(chunk: unknown): void; blocks(): readonly { type: string; text?: string }[] }
}

export interface SafeExecutionFailure { readonly code: string; readonly message: string; readonly stage: string }
export interface NormalExecutionPacket {
  readonly historyContext?: DirectHistoryContext
  readonly operationId: string
  readonly callId: string
  readonly model: ModelSelection
  readonly sourceText: string
  readonly targetLanguage: string
  readonly instruction: string
  readonly context: NormalTranslationContext
  /** One real call returns the body to the main model; no control tool and no resume protocol. */
  readonly mode?: 'direct'
  readonly referenceContext?: FrozenReferenceContext
  readonly referenceContextCurrent?: () => boolean
  readonly exchangeResume?: Extract<NormalTranslationResolution, { readonly kind: 'answer' }>
  readonly exchangeContextVersion?: number
}
export type NormalExecutionEvent = TextExecutionEvent | { readonly type: 'needs_context'; readonly input: RequestContextInput }
export interface AnalysisExecutionPacket {
  readonly operationId: string
  readonly callId: string
  readonly model: ModelSelection
  readonly systemPrompt: string
  readonly userMessage: string
}
export interface DocumentExecutionPacket extends AnalysisExecutionPacket {
  readonly attemptId: string
  readonly prompt: DocumentTranslationPrompt
  readonly requestContextAvailable?: boolean
  readonly supplement?: { readonly resolutionId: string; readonly observedVersion: number; readonly answerText: string; readonly organizedRequirements: string }
}
export interface AnalysisExecutionBudget {
  readonly tokens: number
  readonly kind: 'estimated'
  readonly contextWindow: number | null
  readonly maxOutputTokens: number | null
}
type PreparedNormalCall = { route: ModelSelection; call: DshPreparedCall; normalContext?: NormalTranslationContext; requestContext: boolean; direct?: boolean;
  analysisContext?: { readonly systemPrompt: string; readonly userMessage: string };
  exchangeResume?: Extract<NormalTranslationResolution, { readonly kind: 'answer' }> }
const requestContextTool = Object.freeze({
  name: 'request_context',
  description: 'Ask one to three focused questions only when the frozen translation context is insufficient or materially conflicting.',
  parameters: {
    type: 'object', additionalProperties: false, required: ['questions'],
    properties: { questions: { type: 'array', minItems: 1, maxItems: 3, items: {
      type: 'object', additionalProperties: false, required: ['type', 'range', 'question', 'reason'],
      properties: {
        type: { type: 'string', enum: ['missing_context', 'term_ambiguity', 'requirement_conflict'] },
        range: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['start', 'end'],
          properties: { start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 1 } } }] },
        question: { type: 'string', minLength: 1, maxLength: 8192 },
        reason: { type: 'string', minLength: 1, maxLength: 8192 },
      },
    } } },
  },
})
export type LlmModuleLoader = () => Promise<DshLlmHelpers>
const llmModule = '@deepseek-ai/dsh-llm'
/** Resolve from the host composition, including its native package hooks, rather than the external bundle directory. */
export function hostLlmLoader(ctx: DshExecutionContext): LlmModuleLoader {
  return async () => {
    if (!ctx.baseUrl) throw new Error('Host composition anchor unavailable')
    const loader = ctx.get ? ctx.get('loader') as DshExecutionContext['loader'] : ctx.loader
    if (loader?.internal) return await loader.internal.import(llmModule, ctx.baseUrl, {}) as DshLlmHelpers
    const moduleName = 'node:module'
    const urlName = 'node:url'
    const { createRequire } = await import(moduleName) as { createRequire(anchor: string): { resolve(name: string): string } }
    const { pathToFileURL } = await import(urlName) as { pathToFileURL(path: string): { href: string } }
    return await import(pathToFileURL(createRequire(ctx.baseUrl).resolve(llmModule)).href) as DshLlmHelpers
  }
}

function key(route: ModelSelection): string {
  return JSON.stringify([route.providerId, route.modelId, route.configVersion, route.reasoningEffort ?? null])
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const part of Object.values(value)) frozen(part)
    Object.freeze(value)
  }
  return value
}
function code(error: unknown): string {
  const descriptor = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code') : undefined
  const value: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined
  // Provider-defined codes can contain body or credential data too. Only publish known classifications.
  const safe = ['EXECUTION_UNAVAILABLE', 'INVALID_PREPARED_CALL', 'MODEL_UNAVAILABLE', 'INVALID_STREAM', 'OUTPUT_LIMIT',
    'NO_ADAPTER', 'INVALID_MODEL_INFO', 'INVALID_MODEL_REASONING', 'UNSUPPORTED_REASONING_EFFORT', 'MISSING_CREDENTIAL',
    'INVALID_CREDENTIAL', 'CONTEXT_WINDOW_EXCEEDED', 'INPUT_LIMIT', 'QUOTA', 'ACCOUNT_QUOTA', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE']
  return typeof value === 'string' && safe.includes(value) ? value : 'EXECUTION_FAILED'
}
function failure(error: unknown, stage: string): SafeExecutionFailure {
  return { code: code(error), stage, message: stage === 'prepare' ? '无法准备所选模型，请检查模型配置或更换模型。' : stage === 'protocol' ? '模型返回了不完整或不支持的响应。' : '模型调用失败，请检查模型配置后重试。' }
}

/** Calls the registered DSH adapter once, with a detached native Session and no tools. */
export class DshTextExecutionAdapter implements TextExecutionAdapter {
  private readonly generation = `dsh-quick:${crypto.randomUUID()}`
  private readonly prepared = new Map<string, PreparedNormalCall>()
  private readonly routes = new Map<string, ModelSelection>()
  private readonly failures = new Map<string, SafeExecutionFailure>()
  private readonly logs = new Map<string, readonly unknown[]>()
  private readonly callOperations = new Map<string, string>()
  private readonly calls = new Map<string, Omit<TranslationCallMetadata, 'usage'>>()
  private helpers: DshLlmHelpers | undefined
  private loading: Promise<DshLlmHelpers> | undefined
  constructor(private readonly ctx: DshExecutionContext, private readonly loadModule: LlmModuleLoader = hostLlmLoader(ctx)) {}
  private get llm(): DshExecutionContext['llm'] { return this.ctx.get ? this.ctx.get('llm') as DshExecutionContext['llm'] : this.ctx.llm }
  private get sessions(): DshExecutionContext['sessions'] { return this.ctx.get ? this.ctx.get('sessions') as DshExecutionContext['sessions'] : this.ctx.sessions }

  async ready(): Promise<boolean> {
    if (!this.llm?.prepareCall || !this.llm.listModels || !this.llm.resolveModelInfo || !this.sessions?.prepare) return false
    try {
      this.helpers ??= await (this.loading ??= this.loadModule())
      return typeof this.helpers.createSystemMessage === 'function' && typeof this.helpers.createUserMessage === 'function' &&
        typeof this.helpers.createAssistantMessage === 'function' && typeof this.helpers.AssistantStreamAccumulator === 'function' && typeof this.helpers.BlockAssembler === 'function'
    } catch { this.loading = undefined; return false }
  }

  async prepareOperation(operationId: string, route: ModelSelection, signal: AbortSignal): Promise<void> {
    const report = diagnosticSpan(this.ctx, 'model.prepare', { provider: route.providerId, model: route.modelId }, operationId)
    try {
      if (!await this.ready()) throw Object.assign(new Error('DSH text runtime unavailable'), { code: 'EXECUTION_UNAVAILABLE' })
      signal.throwIfAborted()
      const llm = this.llm!
      const models = await llm.listModels(route.providerId)
      signal.throwIfAborted()
      if (!models.some(model => model.provider === route.providerId && model.id === route.modelId)) {
        throw Object.assign(new Error('Selected model is absent from catalog'), { code: 'MODEL_UNAVAILABLE' })
      }
      const info = await llm.resolveModelInfo(route.providerId, route.modelId, signal)
      signal.throwIfAborted()
      if (info.provider !== route.providerId || info.id !== route.modelId ||
        (route.reasoningEffort !== undefined && !info.reasoning?.efforts.some(effort => effort.id === route.reasoningEffort))) {
        throw Object.assign(new Error('Selected model effort is unavailable'), { code: 'MODEL_UNAVAILABLE' })
      }
      const call = await llm.prepareCall({
        provider: route.providerId, model: route.modelId,
        ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
      }, signal)
      signal.throwIfAborted()
      if (call.config.provider !== route.providerId || call.config.model !== route.modelId ||
        (route.reasoningEffort !== undefined && call.config.reasoningEffort !== route.reasoningEffort)) {
        throw Object.assign(new Error('Prepared route changed'), { code: 'INVALID_PREPARED_CALL' })
      }
      this.prepared.set(operationId, { route: frozen(structuredClone(route)), call, requestContext: false })
      this.routes.set(key(route), frozen(structuredClone(route)))
      report('completed')
    } catch (error) { const diagnostic = failure(error, 'prepare'); report(signal.aborted ? 'cancelled' : 'failed', { failureCode: diagnostic.code, failureStage: diagnostic.stage }, error); this.failures.set(operationId, diagnostic); throw error }
  }

  discard(operationId: string): void { this.prepared.delete(operationId) }
  forgetCallLog(callId: string): void {
    const operationId = this.callOperations.get(callId)
    if (operationId) this.logs.delete(operationId)
    this.callOperations.delete(callId)
  }
  /** Prepare the real selected route without dispatching a stream or retaining any document body. */
  async prepareDocumentCapacity(operationId: string, route: ModelSelection, signal: AbortSignal): Promise<DocumentPreparedCapacity> {
    await this.prepareOperation(operationId, route, signal)
    const bound = this.prepared.get(operationId)!
    const contextWindow = bound.call.context?.contextWindow ?? null, maxOutputTokens = bound.call.config.maxTokens ?? null
    for (const count of [contextWindow, maxOutputTokens]) {
      if (count !== null && (!Number.isSafeInteger(count) || count <= 0)) {
        this.discard(operationId)
        throw Object.assign(new Error('Prepared capacity is invalid'), { code: 'INVALID_PREPARED_CALL' })
      }
    }
    // The public rc.2 prepared-call contract exposes no tokenizer. UTF-8 accounting remains estimated.
    return frozen({ route: { provider: bound.call.config.provider, model: bound.call.config.model,
      ...(bound.call.config.reasoningEffort === undefined ? {} : { reasoningEffort: bound.call.config.reasoningEffort }) },
      contextWindow, maxOutputTokens, countKind: 'estimated' as const })
  }
  diagnostic(operationId: string): SafeExecutionFailure | undefined { return this.failures.get(operationId) }
  callMetadata(operationId: string): Omit<TranslationCallMetadata, 'usage'> | undefined { return this.calls.get(operationId) }
  /** rc.2 has no public structured-output declaration. Use strict, bounded JSON parsing in the caller. */
  preflightAnalysis(packet: AnalysisExecutionPacket, extraInputBytes = 0): AnalysisExecutionBudget & { readonly route: TranslationMaterialRoute } {
    try {
      const bound = this.prepared.get(packet.operationId)
      if (!bound || key(bound.route) !== key(packet.model)) throw Object.assign(new Error('Analysis preparation unavailable'), { code: 'INVALID_PREPARED_CALL' })
      const bytes = new TextEncoder().encode(packet.systemPrompt + packet.userMessage).byteLength + extraInputBytes
      // UTF-8 bytes are an estimate, not proof of token overflow. The bound adapter
      // applies the actual call parameters and reports real provider rejections.
      this.prepared.set(packet.operationId, { ...bound, analysisContext: frozen({ systemPrompt: packet.systemPrompt, userMessage: packet.userMessage }) })
      return { tokens: bytes + 16, kind: 'estimated', contextWindow: bound.call.context?.contextWindow ?? null, maxOutputTokens: bound.call.config.maxTokens ?? null,
        route: { provider: bound.call.config.provider, model: bound.call.config.model,
          ...(bound.call.config.reasoningEffort === undefined ? {} : { reasoningEffort: bound.call.config.reasoningEffort }) } }
    } catch (error) { this.failures.set(packet.operationId, failure(error, 'prepare')); throw error }
  }
  /** Legacy scheduling hint, never a preflight rejection threshold. */
  analysisInputBudget(operationId: string): number {
    const bound = this.prepared.get(operationId)
    if (!bound) throw Object.assign(new Error('Analysis preparation unavailable'), { code: 'INVALID_PREPARED_CALL' })
    return bound.call.context ? bound.call.context.contextWindow - (bound.call.config.maxTokens ?? 0) - 16 : 196608
  }
  /** Document calls keep their actual prompt version and reference-only context metadata. */
  preflightDocument(packet: DocumentExecutionPacket): DocumentCallRecord {
    const bound = this.prepared.get(packet.operationId)
    const requestContext = packet.requestContextAvailable === true && bound?.call.toolUpdate !== undefined
    const context = this.documentContext(packet, requestContext)
    // Reuse the actual declaration passed to stream(), including its complete serialized input budget.
    const toolBytes = requestContext ? new TextEncoder().encode(JSON.stringify([requestContextTool])).byteLength : 0
    const actual = this.preflightAnalysis({ ...packet, ...context }, toolBytes)
    if (packet.prompt.promptVersion !== DOCUMENT_TRANSLATION_PROMPT_VERSION || packet.systemPrompt !== packet.prompt.systemPrompt ||
      packet.userMessage !== packet.prompt.userMessage) throw Object.assign(new Error('Document prompt identity changed'), { code: 'INVALID_PREPARED_CALL' })
    this.prepared.set(packet.operationId, { ...this.prepared.get(packet.operationId)!, requestContext })
    return frozen({ callId: packet.callId, attemptId: packet.attemptId, promptVersion: requestContext ? DOCUMENT_TRANSLATION_CONTEXT_PROMPT_VERSION : packet.prompt.promptVersion,
      model: { provider: actual.route.provider, model: actual.route.model, reasoningEffort: actual.route.reasoningEffort ?? null },
      configVersion: null, maxOutputTokens: actual.maxOutputTokens, usage: { inputTokens: null, outputTokens: null },
      contextRef: structuredClone(packet.prompt.contextRef) })
  }
  private documentContext(packet: DocumentExecutionPacket, requestContext: boolean): { systemPrompt: string; userMessage: string } {
    if (!requestContext && !packet.supplement) return { systemPrompt: packet.systemPrompt, userMessage: packet.userMessage }
    const body = JSON.parse(packet.userMessage) as Record<string, unknown>
    body.tool_permissions = requestContext ? 'request_context_only' : 'none'
    if (packet.supplement) body.main_model_supplement = packet.supplement
    const systemPrompt = reconstructDocumentSystemPrompt(requestContext)
    return { systemPrompt, userMessage: JSON.stringify(body) }
  }
  documentRequestContextAvailable(operationId: string): boolean { return this.prepared.get(operationId)?.call.toolUpdate !== undefined }
  async *executeDocument(packet: DocumentExecutionPacket, signal: AbortSignal, onDispatch?: () => void): AsyncGenerator<NormalExecutionEvent> {
    const bound = this.prepared.get(packet.operationId)
    this.prepared.delete(packet.operationId)
    const context = this.documentContext(packet, bound?.requestContext === true)
    if (!bound || key(bound.route) !== key(packet.model) || !bound.analysisContext ||
      bound.analysisContext.systemPrompt !== context.systemPrompt || bound.analysisContext.userMessage !== context.userMessage) {
      throw Object.assign(new Error('Document preparation does not match'), { code: 'INVALID_PREPARED_CALL' })
    }
    const outputRange = (JSON.parse(packet.prompt.userMessage) as { output_range: { start: number; end: number } }).output_range
    yield* this.executePrepared(packet.operationId, packet.callId, bound.call, 'document', context,
      signal, undefined, onDispatch, bound.requestContext, outputRange.end - outputRange.start)
  }
  /** Same native route preparation, stream validator, and detached Session as translation calls. */
  async *executeAnalysis(packet: AnalysisExecutionPacket, signal: AbortSignal, onDispatch?: () => void): AsyncGenerator<TextExecutionEvent> {
    const bound = this.prepared.get(packet.operationId)
    this.prepared.delete(packet.operationId)
    if (!bound || key(bound.route) !== key(packet.model) || !bound.analysisContext ||
      bound.analysisContext.systemPrompt !== packet.systemPrompt || bound.analysisContext.userMessage !== packet.userMessage) throw new Error('Analysis execution preparation does not match')
    for await (const event of this.executePrepared(packet.operationId, packet.callId, bound.call, 'analysis', bound.analysisContext, signal,
      undefined, onDispatch)) {
      if (event.type === 'needs_context') throw Object.assign(new Error('Analysis cannot request tools'), { code: 'INVALID_STREAM' })
      yield event
    }
  }
  /** Full native prepared-call config and a conservative estimate, before business acceptance. */
  preflightNormal(packet: NormalExecutionPacket, requestContextAvailable = false): TranslationCallMetadata {
    try {
      const bound = this.prepared.get(packet.operationId)
      if (!bound || key(bound.route) !== key(packet.model)) throw Object.assign(new Error('Normal preparation unavailable'), { code: 'INVALID_PREPARED_CALL' })
      if(packet.context.referenceContextRef && (!packet.referenceContext || JSON.stringify(packet.context.referenceContextRef)!==JSON.stringify(packet.referenceContext.manifestRef)) || packet.referenceContextCurrent?.()===false)throw Object.assign(new Error('Reference context unavailable or changed'),{code:'REFERENCE_CONTEXT_CHANGED'})
      const direct = packet.mode === 'direct'
      const requestContext = !direct && requestContextAvailable && bound.call.toolUpdate !== undefined
      const material = { source: packet.sourceText, targetLanguage: packet.targetLanguage, instruction: packet.instruction }
      const context = requestContext
        ? reconstructNormalExchangeTranslationContext(material, packet.context, bound.exchangeResume, packet.referenceContext)
        : direct ? reconstructDirectTranslationContext(material, packet.context, packet.referenceContext, packet.historyContext)
        : reconstructNormalTranslationContext(material, packet.context, packet.referenceContext)
      // Model capacity is decided by the bound adapter, not by treating bytes as tokens.
      const normalContext = frozen(structuredClone(packet.context))
      this.prepared.set(packet.operationId, { ...bound, normalContext, requestContext, direct })
      return { promptVersion: requestContext ? NORMAL_TRANSLATION_EXCHANGE_PROMPT_VERSION : direct ? NORMAL_TRANSLATION_DIRECT_PROMPT_VERSION : NORMAL_TRANSLATION_PROMPT_VERSION,
        model: { provider: bound.call.config.provider, model: bound.call.config.model,
        reasoningEffort: bound.call.config.reasoningEffort ?? null }, configVersion: null, maxOutputTokens: bound.call.config.maxTokens ?? null,
        usage: { inputTokens: null, outputTokens: null }, context: normalContext,
        ...(requestContext ? { exchangeContext: bound.exchangeResume
          ? { contextVersion: packet.exchangeContextVersion ?? 1, resolutionRefs: [{ resolutionId: bound.exchangeResume.resolutionId }] }
          : { contextVersion: 1, resolutionRefs: [] } } : {}) }
    } catch (error) { this.failures.set(packet.operationId, failure(error, 'prepare')); throw error }
  }
  async prepareNormalResume(packet: NormalExecutionPacket, signal: AbortSignal): Promise<TranslationCallMetadata> {
    if (!packet.exchangeResume) throw new Error('Resume resolution is missing')
    await this.prepareOperation(packet.operationId, packet.model, signal)
    const bound = this.prepared.get(packet.operationId)
    if (!bound?.call.toolUpdate) throw Object.assign(new Error('Resume route no longer supports tools'), { code: 'INVALID_PREPARED_CALL' })
    this.prepared.set(packet.operationId, { ...bound, normalContext: frozen(structuredClone(packet.context)), requestContext: true,
      exchangeResume: frozen(structuredClone(packet.exchangeResume)) })
    return this.preflightNormal(packet, true)
  }
  /** Host diagnostics only; this is never registered as a Remote method. */
  inspectLog(operationId: string): readonly unknown[] | undefined { return this.logs.get(operationId) }
  inspectCallLog(callId: string): readonly unknown[] | undefined { const operation = this.callOperations.get(callId); return operation ? this.logs.get(operation) : undefined }

  capabilities(route: ModelSelection): TextCapabilityEvidence {
    return {
      verified: this.routes.has(key(route)), route, adapter_generation: this.generation,
      modes: ['quick'], runtime_only_confirmed: true, reconstructable_log_confirmed: true,
      max_source_code_points: 1_000_000,
    }
  }

  async *execute(packet: TextExecutionPacket, signal: AbortSignal): AsyncIterable<TextExecutionEvent> {
    const bound = this.prepared.get(packet.operation_id)
    this.prepared.delete(packet.operation_id)
    if (!bound || key(bound.route) !== key(packet.model) || packet.mode !== 'quick' || packet.tool_names.length || packet.memory_refs.length || packet.main_history.length) {
      throw new Error('Quick execution preparation does not match')
    }
    for await (const event of this.executePrepared(packet.operation_id, packet.attempt_id, bound.call, 'quick',
      reconstructTranslationContext({ source: packet.source_text, targetLanguage: packet.target_language, instruction: packet.instruction }), signal)) {
      if (event.type === 'needs_context') throw Object.assign(new Error('Quick translation cannot request context'), { code: 'INVALID_STREAM' })
      yield event
    }
  }
  async *executeNormal(packet: NormalExecutionPacket, signal: AbortSignal, onDispatch?: () => void): AsyncGenerator<NormalExecutionEvent> {
    const bound = this.prepared.get(packet.operationId)
    this.prepared.delete(packet.operationId)
    if(packet.referenceContextCurrent?.()===false)throw Object.assign(new Error('Reference context changed before dispatch'),{code:'REFERENCE_CONTEXT_CHANGED'})
    if (!bound || key(bound.route) !== key(packet.model) || !bound.normalContext || JSON.stringify(bound.normalContext) !== JSON.stringify(packet.context)) throw new Error('Normal execution preparation does not match')
    const material = { source: packet.sourceText, targetLanguage: packet.targetLanguage, instruction: packet.instruction }
    const promptVersion = bound.requestContext ? NORMAL_TRANSLATION_EXCHANGE_PROMPT_VERSION : bound.direct ? NORMAL_TRANSLATION_DIRECT_PROMPT_VERSION : NORMAL_TRANSLATION_PROMPT_VERSION
    yield* this.executePrepared(packet.operationId, packet.callId, bound.call, 'normal',
      bound.requestContext ? reconstructNormalExchangeTranslationContext(material, bound.normalContext, bound.exchangeResume, packet.referenceContext)
        : bound.direct ? reconstructDirectTranslationContext(material, bound.normalContext, packet.referenceContext, packet.historyContext)
        : reconstructNormalTranslationContext(material, bound.normalContext, packet.referenceContext),
      signal, bound.normalContext, onDispatch, bound.requestContext, Array.from(packet.sourceText).length, bound.exchangeResume, packet.exchangeContextVersion, promptVersion)
  }
  private async *executePrepared(operationId: string, attemptId: string, call: DshPreparedCall, mode: 'quick' | 'normal' | 'analysis' | 'document',
    context: { readonly systemPrompt: string; readonly userMessage: string }, signal: AbortSignal, normalContext?: NormalTranslationContext,
    onDispatch?: () => void, requestContext = false, sourceCodePointLength = 0,
    exchangeResume?: Extract<NormalTranslationResolution, { readonly kind: 'answer' }>, exchangeContextVersion = 1,
    promptVersion?: TranslationCallMetadata['promptVersion']): AsyncGenerator<NormalExecutionEvent> {
    const report = diagnosticSpan(this.ctx, 'model.stream', { mode, promptVersion, provider: call.config.provider, model: call.config.model, inputChars: context.systemPrompt.length + context.userMessage.length, terms: normalContext?.terms.length }, operationId)
    const helpers = this.helpers!
    const session = this.sessions!.prepare(`translation-${mode}:${attemptId}`)
    this.callOperations.set(attemptId, operationId)
    const events: unknown[] = []
    const append = (type: string, data: unknown, surface = false): void => {
      events.push(session.append(type, data, ...(surface ? [{ surfaceOp: 'append' as const }] : [])))
      this.logs.set(operationId, Object.freeze([...events]))
    }
    append('system/message', { message: helpers.createSystemMessage(context.systemPrompt) }, true)
    append('user/message', helpers.createUserMessage({
      content: [{ type: 'text', text: context.userMessage }], source: { kind: 'user' },
    }), true)
    append('request/header', {
      header: {
        config: call.config,
        ...(Object.keys(call.adapterDefaults).length ? { adapterDefaults: call.adapterDefaults } : {}),
      }, reason: 'initial', startsSeries: true,
    })
    const options = Object.freeze({ ...call.config, messages: frozen([...session.deriveMessages()]), signal,
      ...(mode !== 'quick' ? { tools: requestContext ? Object.freeze([requestContextTool]) : Object.freeze([]) } : {}) })
    const stream = new helpers.AssistantStreamAccumulator()
    const assembler = new helpers.BlockAssembler()
    const blocks = new Map<number, { type: 'text' | 'reasoning' | 'tool-call'; declared: boolean; text: string }>()
    const toolCalls = new Map<number, { id?: string; name?: string; arguments: string }>()
    const closed = new Set<number>()
    let finish: Record<string, unknown> | undefined
    let totalText = 0
    let emittedText = ''
    let settlementDone = false
    try {
      signal.throwIfAborted()
      if (mode !== 'analysis' && mode !== 'document') this.calls.set(operationId, Object.freeze({ promptVersion: promptVersion
        ?? (mode === 'normal' ? requestContext ? NORMAL_TRANSLATION_EXCHANGE_PROMPT_VERSION : NORMAL_TRANSLATION_PROMPT_VERSION : TRANSLATION_PROMPT_VERSION),
        model: Object.freeze({ provider: call.config.provider, model: call.config.model, reasoningEffort: call.config.reasoningEffort ?? null }),
        configVersion: null, maxOutputTokens: call.config.maxTokens ?? null, ...(normalContext ? { context: normalContext } : {}),
        ...(requestContext ? { exchangeContext: exchangeResume
          ? { contextVersion: exchangeContextVersion, resolutionRefs: [{ resolutionId: exchangeResume.resolutionId }] }
          : { contextVersion: 1, resolutionRefs: [] } } : {}) }))
      onDispatch?.()
      for await (const chunk of call.stream(options)) {
        if (finish) throw Object.assign(new Error('Chunk after terminal'), { code: 'INVALID_STREAM' })
        if (!chunk || typeof chunk !== 'object' || typeof chunk.type !== 'string') throw new Error('Invalid stream chunk')
        stream.push({ time: Date.now(), chunk })
        if (chunk.type === 'block-start') {
          if (!Number.isSafeInteger(chunk.index) || (chunk.index as number) < 0 || blocks.has(chunk.index as number) ||
            (chunk.blockType !== 'text' && chunk.blockType !== 'reasoning' && chunk.blockType !== 'tool-call')) throw Object.assign(new Error('Unsupported block'), { code: 'INVALID_STREAM' })
          blocks.set(chunk.index as number, { type: chunk.blockType, declared: true, text: '' })
        } else if (chunk.type === 'tool-call-delta') {
          const index = chunk.index as number, id = chunk.id as string, name = chunk.name as string | undefined, args = chunk.argumentsDelta as string
          if (!Number.isSafeInteger(index) || index < 0 || typeof id !== 'string' || !id || (name !== undefined && typeof name !== 'string') ||
            typeof args !== 'string' || closed.has(index)) throw Object.assign(new Error('Invalid tool-call delta'), { code: 'INVALID_STREAM' })
          const block = blocks.get(index) ?? { type: 'tool-call' as const, declared: false, text: '' }
          if (block.type !== 'tool-call') throw Object.assign(new Error('Tool-call block type changed'), { code: 'INVALID_STREAM' })
          const callState = toolCalls.get(index) ?? { arguments: '' }
          if (callState.id !== undefined && callState.id !== id || name !== undefined && callState.name !== undefined && callState.name !== name) {
            throw Object.assign(new Error('Tool-call identity changed'), { code: 'INVALID_STREAM' })
          }
          callState.id = id; if (name !== undefined && name !== '') callState.name = name
          callState.arguments += args
          if (callState.arguments.length > 32_768) throw Object.assign(new Error('Tool-call arguments exceed limit'), { code: 'INVALID_STREAM' })
          toolCalls.set(index, callState); blocks.set(index, block)
        } else if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
          const type = chunk.type === 'text-delta' ? 'text' : 'reasoning'
          if (!Number.isSafeInteger(chunk.index) || (chunk.index as number) < 0 || typeof chunk.text !== 'string' || closed.has(chunk.index as number)) throw Object.assign(new Error('Invalid delta'), { code: 'INVALID_STREAM' })
          const block = blocks.get(chunk.index as number) ?? { type, declared: false, text: '' }
          if (block.type !== type) throw Object.assign(new Error('Invalid delta block type'), { code: 'INVALID_STREAM' })
          block.text += chunk.text
          blocks.set(chunk.index as number, block)
          if (type === 'text') {
            totalText += chunk.text.length
            if (mode !== 'document' && totalText > (mode === 'analysis' ? 131072 : 2_000_000)) throw Object.assign(new Error('Output exceeds limit'), { code: 'OUTPUT_LIMIT' })
            emittedText += chunk.text
            yield { type: 'text', text: chunk.text }
          }
        } else if (chunk.type === 'block-end') {
          const block = chunk.block as { type?: string; text?: string } | undefined
          const partial = blocks.get(chunk.index as number)
          if (!Number.isSafeInteger(chunk.index) || (chunk.index as number) < 0 || !block ||
            (block.type !== 'text' && block.type !== 'reasoning' && block.type !== 'tool-call') || (partial && partial.type !== block.type) ||
            closed.has(chunk.index as number) || (block.type !== 'tool-call' && typeof block.text !== 'string') ||
            (block.type !== 'tool-call' && partial?.text && partial.text !== block.text)) {
            throw Object.assign(new Error('Invalid block end'), { code: 'INVALID_STREAM' })
          }
          if (block.type === 'tool-call') {
            const call = block as { type: string; id?: string; name?: string; arguments?: string }
            const callState = toolCalls.get(chunk.index as number)
            if (!callState || !callState.id || !callState.name || typeof call.arguments !== 'string' ||
              call.id !== callState.id || call.name !== callState.name || call.arguments !== callState.arguments) {
              throw Object.assign(new Error('Incomplete tool-call block'), { code: 'INVALID_STREAM' })
            }
          }
          blocks.set(chunk.index as number, { type: block.type, declared: partial?.declared ?? false, text: block.type === 'tool-call' ? '' : block.text! })
          if (block.type === 'text' && !partial?.text) {
            const blockText = block.text!
            totalText += blockText.length
            if (mode !== 'document' && totalText > (mode === 'analysis' ? 131072 : 2_000_000)) throw Object.assign(new Error('Output exceeds limit'), { code: 'OUTPUT_LIMIT' })
            emittedText += blockText
            yield { type: 'text', text: blockText }
          }
          closed.add(chunk.index as number)
        } else if (chunk.type === 'usage') {
          const usage = chunk.usage as { inputTokens?: number; outputTokens?: number } | undefined
          if (!usage || !Number.isSafeInteger(usage.inputTokens) || !Number.isSafeInteger(usage.outputTokens) || usage.inputTokens! < 0 || usage.outputTokens! < 0) throw Object.assign(new Error('Invalid usage'), { code: 'INVALID_STREAM' })
          yield { type: 'usage', input_tokens: usage.inputTokens!, output_tokens: usage.outputTokens! }
        } else if (chunk.type === 'finish') {
          const reason = chunk.reason as Record<string, unknown> | undefined
          if (!reason || !['stop', 'tool-calls', 'max-tokens', 'error', 'aborted'].includes(String(reason.kind))) throw Object.assign(new Error('Unsupported terminal'), { code: 'INVALID_STREAM' })
          finish = reason
        } else throw Object.assign(new Error('Unsupported stream chunk'), { code: 'INVALID_STREAM' })
        assembler.push(chunk)
      }
      if (!finish) throw Object.assign(new Error('Missing terminal'), { code: 'INVALID_STREAM' })
      let needsContext: RequestContextInput | undefined
      if (toolCalls.size || finish.kind === 'tool-calls') {
        if (!requestContext || finish.kind !== 'tool-calls' || toolCalls.size !== 1 ||
          [...blocks].some(([index, block]) => block.declared && !closed.has(index))) throw Object.assign(new Error('Unexpected or incomplete tool-call response'), { code: 'INVALID_STREAM' })
        const call = [...toolCalls.values()][0]!
        if (call.name !== 'request_context' || !call.id) throw Object.assign(new Error('Unknown control tool'), { code: 'INVALID_STREAM' })
        try { needsContext = parseRequestContextInput(JSON.parse(call.arguments), sourceCodePointLength) }
        catch { throw Object.assign(new Error('Invalid request_context payload'), { code: 'INVALID_STREAM' }) }
      }
      const assembledText = assembler.blocks().filter(block => block.type === 'text').map(block => block.text ?? '').join('')
      if (assembledText !== emittedText) throw Object.assign(new Error('Assembled text differs from emitted text'), { code: 'INVALID_STREAM' })
      const complete = !needsContext && finish.kind === 'stop' && !signal.aborted && [...blocks].every(([index, block]) => !block.declared || closed.has(index)) && !!assembledText.trim()
      if (finish.kind === 'stop' && !complete) throw Object.assign(new Error('Incomplete blocks'), { code: 'INVALID_STREAM' })
      if (finish.kind === 'stop' || finish.kind === 'max-tokens' || needsContext) {
        const content = assembler.blocks()
        append('assistant/message', { turn: 0, step: 0, message: helpers.createAssistantMessage({ content, source: { provider: call.config.provider, model: call.config.model } }), stream: stream.snapshot() }, true)
      } else {
        append('assistant/attempt', { turn: 0, step: 0, stream: stream.snapshot() })
        this.failures.set(operationId, failure(finish.failure, 'stream'))
      }
      settlementDone = true
      if (needsContext) yield { type: 'needs_context', input: needsContext }
      // rc.2 wraps *any* adapter throw while signal.aborted as kind:'aborted'. Preserve non-abort failures.
      const nativeFailure = finish.failure as { code?: unknown } | undefined
      const abortFailureUnknown = mode === 'document' && finish.kind === 'aborted' && nativeFailure !== undefined && nativeFailure.code !== 'ABORTED'
      report(signal.aborted || finish.kind === 'aborted' ? 'cancelled' : complete ? 'completed' : 'incomplete', { finishKind: String(finish.kind), outputChars: totalText, needsContext: !!needsContext, providerUnknown: abortFailureUnknown })
      yield {
        type: 'terminal', reason: abortFailureUnknown ? 'error' : signal.aborted || finish.kind === 'aborted' ? 'aborted' : finish.kind === 'max-tokens' ? 'max_tokens' : finish.kind === 'error' ? 'error' : 'stop',
        completeness: complete ? 'complete' : 'incomplete', checks_passed: complete,
        provider_state: abortFailureUnknown ? 'unknown' : finish.kind === 'aborted' || signal.aborted ? 'stopped' : 'finished',
      }
    } catch (error) {
      const diagnostic = failure(error, code(error) === 'INVALID_STREAM' || code(error) === 'OUTPUT_LIMIT' ? 'protocol' : 'stream')
      report(signal.aborted ? 'cancelled' : 'failed', { outputChars: totalText, failureCode: diagnostic.code, failureStage: diagnostic.stage }, error)
      this.failures.set(operationId, diagnostic)
      throw error
    } finally {
      if (!settlementDone) append('assistant/attempt', { turn: 0, step: 0, stream: stream.snapshot() })
    }
  }
}
