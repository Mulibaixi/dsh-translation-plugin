import type { ModelSelection } from '../shared/contracts.js'
import type { TextCapabilityEvidence, TextExecutionAdapter, TextExecutionEvent, TextExecutionPacket } from '../shared/domain-contracts.js'
import { TRANSLATION_PROMPT_VERSION, reconstructTranslationContext, type TranslationCallMetadata } from '../shared/translation-call.js'
export { QUICK_SYSTEM_PROMPT } from '../shared/translation-call.js'

/** Narrow views of the 0.2.0-rc.2 public runtime, checked against the installed packages. */
export interface DshPreparedCall {
  readonly config: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string; readonly maxTokens?: number }
  readonly adapterDefaults: Record<string, true>
  stream(options: Record<string, unknown>): AsyncIterable<Record<string, unknown>>
}
export interface DshDetachedSession {
  append(type: string, data: unknown, options?: { surfaceOp: 'append' }): unknown
  deriveMessages(): readonly unknown[]
}
export interface DshExecutionContext {
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
    'INVALID_CREDENTIAL', 'CONTEXT_WINDOW_EXCEEDED', 'QUOTA', 'ACCOUNT_QUOTA', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE']
  return typeof value === 'string' && safe.includes(value) ? value : 'EXECUTION_FAILED'
}
function failure(error: unknown, stage: string): SafeExecutionFailure {
  return { code: code(error), stage, message: stage === 'prepare' ? '无法准备所选模型，请检查模型配置或更换模型。' : stage === 'protocol' ? '模型返回了不完整或不支持的响应。' : '模型调用失败，请检查模型配置后重试。' }
}

/** Calls the registered DSH adapter once, with a detached native Session and no tools. */
export class DshTextExecutionAdapter implements TextExecutionAdapter {
  private readonly generation = `dsh-quick:${crypto.randomUUID()}`
  private readonly prepared = new Map<string, { route: ModelSelection; call: DshPreparedCall }>()
  private readonly routes = new Map<string, ModelSelection>()
  private readonly failures = new Map<string, SafeExecutionFailure>()
  private readonly logs = new Map<string, readonly unknown[]>()
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
    if (!await this.ready()) throw Object.assign(new Error('DSH text runtime unavailable'), { code: 'EXECUTION_UNAVAILABLE' })
    try {
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
      this.prepared.set(operationId, { route: frozen(structuredClone(route)), call })
      this.routes.set(key(route), frozen(structuredClone(route)))
    } catch (error) { this.failures.set(operationId, failure(error, 'prepare')); throw error }
  }

  discard(operationId: string): void { this.prepared.delete(operationId) }
  diagnostic(operationId: string): SafeExecutionFailure | undefined { return this.failures.get(operationId) }
  callMetadata(operationId: string): Omit<TranslationCallMetadata, 'usage'> | undefined { return this.calls.get(operationId) }
  /** Host diagnostics only; this is never registered as a Remote method. */
  inspectLog(operationId: string): readonly unknown[] | undefined { return this.logs.get(operationId) }

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
    const helpers = this.helpers!
    const session = this.sessions!.prepare(`translation-quick:${packet.attempt_id}`)
    const events: unknown[] = []
    const append = (type: string, data: unknown, surface = false): void => {
      events.push(session.append(type, data, ...(surface ? [{ surfaceOp: 'append' as const }] : [])))
      this.logs.set(packet.operation_id, Object.freeze([...events]))
    }
    const context = reconstructTranslationContext({ source: packet.source_text, targetLanguage: packet.target_language, instruction: packet.instruction })
    append('system/message', { message: helpers.createSystemMessage(context.systemPrompt) }, true)
    append('user/message', helpers.createUserMessage({
      content: [{ type: 'text', text: context.userMessage }], source: { kind: 'user' },
    }), true)
    append('request/header', {
      header: {
        config: bound.call.config,
        ...(Object.keys(bound.call.adapterDefaults).length ? { adapterDefaults: bound.call.adapterDefaults } : {}),
      }, reason: 'initial', startsSeries: true,
    })
    const options = Object.freeze({ ...bound.call.config, messages: frozen([...session.deriveMessages()]), signal })
    const stream = new helpers.AssistantStreamAccumulator()
    const assembler = new helpers.BlockAssembler()
    const blocks = new Map<number, { type: 'text' | 'reasoning'; declared: boolean; text: string }>()
    const closed = new Set<number>()
    let finish: Record<string, unknown> | undefined
    let totalText = 0
    let emittedText = ''
    let settlementDone = false
    try {
      signal.throwIfAborted()
      this.calls.set(packet.operation_id, Object.freeze({ promptVersion: TRANSLATION_PROMPT_VERSION,
        model: Object.freeze({ provider: bound.call.config.provider, model: bound.call.config.model, reasoningEffort: bound.call.config.reasoningEffort ?? null }),
        configVersion: null, maxOutputTokens: bound.call.config.maxTokens ?? null }))
      for await (const chunk of bound.call.stream(options)) {
        if (finish) throw Object.assign(new Error('Chunk after terminal'), { code: 'INVALID_STREAM' })
        if (!chunk || typeof chunk !== 'object' || typeof chunk.type !== 'string') throw new Error('Invalid stream chunk')
        stream.push({ time: Date.now(), chunk })
        if (chunk.type === 'block-start') {
          if (!Number.isSafeInteger(chunk.index) || (chunk.index as number) < 0 || blocks.has(chunk.index as number) ||
            (chunk.blockType !== 'text' && chunk.blockType !== 'reasoning')) throw Object.assign(new Error('Unsupported block'), { code: 'INVALID_STREAM' })
          blocks.set(chunk.index as number, { type: chunk.blockType, declared: true, text: '' })
        } else if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
          const type = chunk.type === 'text-delta' ? 'text' : 'reasoning'
          if (!Number.isSafeInteger(chunk.index) || (chunk.index as number) < 0 || typeof chunk.text !== 'string' || closed.has(chunk.index as number)) throw Object.assign(new Error('Invalid delta'), { code: 'INVALID_STREAM' })
          const block = blocks.get(chunk.index as number) ?? { type, declared: false, text: '' }
          if (block.type !== type) throw Object.assign(new Error('Invalid delta block type'), { code: 'INVALID_STREAM' })
          block.text += chunk.text
          blocks.set(chunk.index as number, block)
          if (type === 'text') {
            totalText += chunk.text.length
            if (totalText > 2_000_000) throw Object.assign(new Error('Output exceeds limit'), { code: 'OUTPUT_LIMIT' })
            emittedText += chunk.text
            yield { type: 'text', text: chunk.text }
          }
        } else if (chunk.type === 'block-end') {
          const block = chunk.block as { type?: string; text?: string } | undefined
          const partial = blocks.get(chunk.index as number)
          if (!Number.isSafeInteger(chunk.index) || (chunk.index as number) < 0 || !block ||
            (block.type !== 'text' && block.type !== 'reasoning') || (partial && partial.type !== block.type) ||
            closed.has(chunk.index as number) || typeof block.text !== 'string' || (partial?.text && partial.text !== block.text)) {
            throw Object.assign(new Error('Invalid block end'), { code: 'INVALID_STREAM' })
          }
          blocks.set(chunk.index as number, { type: block.type, declared: partial?.declared ?? false, text: block.text })
          if (block.type === 'text' && !partial?.text) {
            totalText += block.text.length
            if (totalText > 2_000_000) throw Object.assign(new Error('Output exceeds limit'), { code: 'OUTPUT_LIMIT' })
            emittedText += block.text
            yield { type: 'text', text: block.text }
          }
          closed.add(chunk.index as number)
        } else if (chunk.type === 'usage') {
          const usage = chunk.usage as { inputTokens?: number; outputTokens?: number } | undefined
          if (!usage || !Number.isSafeInteger(usage.inputTokens) || !Number.isSafeInteger(usage.outputTokens) || usage.inputTokens! < 0 || usage.outputTokens! < 0) throw Object.assign(new Error('Invalid usage'), { code: 'INVALID_STREAM' })
          yield { type: 'usage', input_tokens: usage.inputTokens!, output_tokens: usage.outputTokens! }
        } else if (chunk.type === 'finish') {
          const reason = chunk.reason as Record<string, unknown> | undefined
          if (!reason || !['stop', 'max-tokens', 'error', 'aborted'].includes(String(reason.kind))) throw Object.assign(new Error('Unsupported terminal'), { code: 'INVALID_STREAM' })
          finish = reason
        } else throw Object.assign(new Error('Unsupported stream chunk'), { code: 'INVALID_STREAM' })
        assembler.push(chunk)
      }
      if (!finish) throw Object.assign(new Error('Missing terminal'), { code: 'INVALID_STREAM' })
      const assembledText = assembler.blocks().filter(block => block.type === 'text').map(block => block.text ?? '').join('')
      if (assembledText !== emittedText) throw Object.assign(new Error('Assembled text differs from emitted text'), { code: 'INVALID_STREAM' })
      const complete = finish.kind === 'stop' && !signal.aborted && [...blocks].every(([index, block]) => !block.declared || closed.has(index)) && !!assembledText.trim()
      if (finish.kind === 'stop' && !complete) throw Object.assign(new Error('Incomplete blocks'), { code: 'INVALID_STREAM' })
      if (finish.kind === 'stop' || finish.kind === 'max-tokens') {
        const content = assembler.blocks()
        append('assistant/message', { turn: 0, step: 0, message: helpers.createAssistantMessage({ content, source: { provider: bound.call.config.provider, model: bound.call.config.model } }), stream: stream.snapshot() }, true)
      } else {
        append('assistant/attempt', { turn: 0, step: 0, stream: stream.snapshot() })
        this.failures.set(packet.operation_id, failure(finish.failure, 'stream'))
      }
      settlementDone = true
      yield {
        type: 'terminal', reason: signal.aborted || finish.kind === 'aborted' ? 'aborted' : finish.kind === 'max-tokens' ? 'max_tokens' : finish.kind === 'error' ? 'error' : 'stop',
        completeness: complete ? 'complete' : 'incomplete', checks_passed: complete,
        provider_state: finish.kind === 'aborted' || signal.aborted ? 'stopped' : 'finished',
      }
    } catch (error) {
      this.failures.set(packet.operation_id, failure(error, code(error) === 'INVALID_STREAM' || code(error) === 'OUTPUT_LIMIT' ? 'protocol' : 'stream'))
      throw error
    } finally {
      if (!settlementDone) append('assistant/attempt', { turn: 0, step: 0, stream: stream.snapshot() })
    }
  }
}
