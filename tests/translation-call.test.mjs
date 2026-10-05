import assert from 'node:assert/strict'
import test from 'node:test'
import { TRANSLATION_PROMPT_VERSION, QUICK_SYSTEM_PROMPT, parseTranslationCallMetadata, reconstructTranslationContext } from '../dist/shared/translation-call.js'
import { QUICK_SYSTEM_PROMPT as adapterPrompt, DshTextExecutionAdapter } from '../dist/host/dsh-text-adapter.js'
import { parseQuickResult } from '../dist/shared/quick-translation.js'

const metadata = { promptVersion: TRANSLATION_PROMPT_VERSION, model: { provider: 'synthetic', model: 'model', reasoningEffort: 'high' },
  configVersion: null, maxOutputTokens: 512, usage: { inputTokens: 7, outputTokens: 4 } }
const completed = { sessionKey: 'synthetic:host', operationId: 'synthetic:operation', draftVersion: 1, accepted: true, status: 'completed', text: 'Synthetic translation' }

test('调用记录边界仅接收安全字段，未提供与真实零计数区分，旧无metadata回执兼容', () => {
  assert.deepEqual(parseTranslationCallMetadata(metadata), metadata)
  for (const usage of [{ inputTokens: null, outputTokens: null }, { inputTokens: 0, outputTokens: 0 }, { inputTokens: 7, outputTokens: null }]) {
    assert.deepEqual(parseTranslationCallMetadata({ ...metadata, usage }).usage, usage)
  }
  assert.doesNotThrow(() => parseQuickResult('status', { ok: true, value: completed }))
  assert.doesNotThrow(() => parseQuickResult('status', { ok: true, value: { ...completed, metadata } }))
  for (const patch of [
    { configVersion: 0 }, { promptVersion: 'invented-version' }, { profile: { secret: 'synthetic-private' } },
    { model: { ...metadata.model, apiKey: 'synthetic-private' } }, { usage: { inputTokens: -1, outputTokens: 4 } },
    { usage: { inputTokens: null } }, { usage: { inputTokens: 7, outputTokens: Number.MAX_SAFE_INTEGER + 1 } },
    { maxOutputTokens: NaN },
  ]) assert.throws(() => parseTranslationCallMetadata({ ...metadata, ...patch }))
  assert.throws(() => parseQuickResult('status', { ok: true, value: { ...completed, status: 'running', accepted: false, text: '', metadata } }))
})

test('固定prompt与payload重建保持原adapter文本和JSON字段顺序', () => {
  assert.equal(adapterPrompt, QUICK_SYSTEM_PROMPT)
  const source = 'Synthetic "quoted" source\nSecond line', instruction = 'Keep synthetic terms'
  const context = reconstructTranslationContext({ source, targetLanguage: '中文', instruction })
  assert.equal(context.systemPrompt, QUICK_SYSTEM_PROMPT)
  assert.equal(context.userMessage, JSON.stringify({ target_language: '中文', translation_requirements: instruction, source_text: source }))
})

test('adapter只投影实际prepared config，默认effort可观测，未进入stream没有调用记录', async () => {
  const blocks = []
  const helpers = {
    createSystemMessage: text => ({ role: 'system', text }), createUserMessage: input => ({ role: 'user', ...input }), createAssistantMessage: input => input,
    AssistantStreamAccumulator: class { push() {} snapshot() { return [] } },
    BlockAssembler: class { push(chunk) { if (chunk.type === 'block-end') blocks.push(chunk.block) } blocks() { return blocks } },
  }
  const messages = [], session = { append(type, data) { if (type === 'system/message') messages.push(data.message); if (type === 'user/message') messages.push(data); return { type, data } }, deriveMessages() { return messages } }
  const adapter = new DshTextExecutionAdapter({
    sessions: { prepare: () => session },
    llm: { async listModels(provider) { return [{ provider, id: 'model' }] }, async resolveModelInfo(provider, id) { return { provider, id } },
      async prepareCall(config) { return { config: { ...config, reasoningEffort: 'high', maxTokens: 512, apiKey: 'synthetic-private', arbitraryProfile: { private: true } }, adapterDefaults: { reasoningEffort: true },
        async *stream() {
          yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: 'Synthetic translation' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Synthetic translation' } }; yield { type: 'finish', reason: { kind: 'stop' } }
        } } },
    },
  }, async () => helpers)
  const route = { providerId: 'synthetic', modelId: 'model', configVersion: 0 }
  await adapter.prepareOperation('synthetic-operation', route, new AbortController().signal)
  assert.equal(adapter.callMetadata('synthetic-operation'), undefined)
  const packet = { operation_id: 'synthetic-operation', attempt_id: 'synthetic-attempt', model: route, mode: 'quick', tool_names: [], memory_refs: [], main_history: [], source_text: 'Synthetic source', target_language: '中文', instruction: '' }
  const events = []
  for await (const event of adapter.execute(packet, new AbortController().signal)) events.push(event)
  assert.equal(events.at(-1).completeness, 'complete')
  assert.deepEqual(adapter.callMetadata('synthetic-operation'), { promptVersion: TRANSLATION_PROMPT_VERSION, model: metadata.model, configVersion: null, maxOutputTokens: 512 })
  assert.ok(!JSON.stringify(adapter.callMetadata('synthetic-operation')).includes('synthetic-private'))
  assert.equal(adapter.callMetadata('synthetic-operation').model.reasoningEffort, 'high')
})
