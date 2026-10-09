import assert from 'node:assert/strict'
import test from 'node:test'
import { NormalTranslationService } from '../dist/host/normal-translation.js'
import { TranslationMaterialsService } from '../dist/host/translation-materials.js'
import { TopicToolsService } from '../dist/host/topic-tools.js'
import { parseNormalTranslationExecute } from '../dist/shared/normal-translation.js'
import { parseTopicBridgeCommand, parseTopicBridgeReply } from '../dist/shared/topic-bridge.js'
import { emptyTopicTerms } from '../dist/memory/topic-terms.js'

const ownerId = 'synthetic-normal-main'
const envelope = { ownerId, mainSessionId: ownerId, requestId: 'submission-a', operationId: 'submission-operation-a', kind: 'material', material: {
  materialId: 'material-a', sourceVersion: 1, topicId: 'topic-a', translationSessionId: 'translation-a', draftVersion: 4,
  sourceText: 'Synthetic frozen source A', targetLanguage: '中文', instruction: '', model: null, maxInputChars: 20000,
} }
const request = { target: { kind: 'material', mainSessionId: ownerId, requestId: envelope.requestId, materialId: 'material-a', sourceVersion: 1 },
  operationId: 'business-a', organizedRequirements: '', termReferences: [] }
function queue() {
  const items = []; let wake, closed = false
  return { push(value) { items.push(value); wake?.(); wake = undefined }, [Symbol.asyncIterator]() { return this },
    async next() { if (!items.length && !closed) await new Promise(resolve => { wake = resolve }); return items.length ? { value: items.shift(), done: false } : { done: true } },
    async return() { closed = true; wake?.(); return { done: true } },
  }
}
async function fixture() {
  const uplink = queue(), hooks = new Map(), registered = new Map(), services = {}
  const agent = { id: ownerId, session: { id: ownerId }, inbox: { nextTurn: [], nextStep: [] }, followup() {}, ctx: { tools: {
    register(definition) { registered.set(definition.name, definition); return () => registered.delete(definition.name) },
  } } }
  const ctx = { invocation: { peer: { id: 'synthetic-peer' }, uplink: () => uplink },
    get(name) { return services[name] ?? { agents: { get: id => id === ownerId ? agent : undefined }, tools: {},
      sessionController: { list: async () => ({ items: [{ sessionId: ownerId }] }) } }[name] },
    on(name, listener) { const listeners = hooks.get(name) ?? []; listeners.push(listener); hooks.set(name, listeners); return () => {} },
  }
  const topics = services.translationTopics = new TopicToolsService(ctx, async () => ({ defineTool: options => options }), 1000)
  const materials = services.translationMaterials = new TranslationMaterialsService(ctx, async () => ({ createUserMessage: input => ({ ...input, id: 'synthetic-material-message', role: 'user' }) }))
  const normal = services.translationNormal = new NormalTranslationService(ctx)
  const controller = new AbortController(), stream = topics.connect({ ownerId, mainSessionId: ownerId }, controller.signal)
  await stream.next()
  const exec = { agent, callId: 'actual-main-tool-call', signal: new AbortController().signal }
  return { normal, materials, topics, stream, uplink, registered, agent, exec,
    async deliver() {
      assert.equal(materials.prepare(envelope).ok, true)
      const message = { id: 'synthetic-main-message', role: 'user', source: { kind: 'user', rpcId: envelope.requestId }, content: [] }
      await hooks.get('agent/pre-step')[0]({ agent, messages: [message], signal: exec.signal }, async () => ({ kind: 'enter', messages: [message] }))
    },
    reply(frame, patch = {}) {
      const operation = { operationId: request.operationId, mainSessionId: ownerId, topicId: 'topic-a', translationSessionId: 'translation-a',
        materialId: 'material-a', unitId: 'client-authority-unit-a', sourceVersion: 1, draftVersion: 4, status: 'accepted', persistence: 'runtime_only', ...patch }
      const value = { kind: 'normal_operation', operation, termSnapshot: emptyTopicTerms(ownerId, 'topic-a', '2026-10-08T00:00:00.000Z') }
      uplink.push(parseTopicBridgeReply({ requestId: frame.requestId, ok: true, value }))
      return value
    },
    async close(waiting) { controller.abort(); await waiting; await stream.return(); normal.dispose(); materials.dispose(); topics.dispose() },
  }
}

test('普通执行工具只接受材料引用、独立operation和术语版本，禁止原文/路由替换', () => {
  assert.deepEqual(parseNormalTranslationExecute(request), request)
  for (const patch of [{ sourceText: 'Model rewritten source' }, { model: { provider: 'other', model: 'other' } }, { profile: {} }]) assert.throws(() => parseNormalTranslationExecute({ ...request, ...patch }))
  assert.throws(() => parseNormalTranslationExecute({ ...request, target: { ...request.target, sourceVersion: 0 } }))
  assert.throws(() => parseNormalTranslationExecute({ ...request, termReferences: [{ id: 'term-a', entryVersion: 1 }, { id: 'term-a', entryVersion: 2 }] }))
  assert.throws(() => parseTopicBridgeCommand({ kind: 'normal_accept', envelope: { ...envelope, kind: 'none', material: undefined }, operationId: 'business-a', organizedRequirements: '', termReferences: [] }))
})

test('普通执行缺模型时零业务受理且材料保留；伪造同id Agent拒绝', async () => {
  const f = await fixture()
  try {
    await f.deliver()
    assert.ok(f.registered.has('translation_execute'))
    assert.throws(() => f.registered.get('translation_execute').execute(request, f.exec), { code: 'model_required', stage: 'prepare' })
    assert.throws(() => f.normal.execute(request, { ...f.exec, agent: { ...f.agent } }), { code: 'scope_mismatch' })
    assert.equal(f.materials.deliveredForAgent(request.target, f.agent).value.material.sourceText, envelope.material.sourceText)
  } finally { await f.close() }
})

test('Host受理基础拒绝prepared/submitted/错误源版本，不能用任意ID取得材料', async () => {
  const f = await fixture()
  try {
    f.materials.prepare(envelope)
    assert.throws(() => f.normal.acceptPrepared(request, f.exec), { code: 'material_not_delivered' })
    f.materials.finish({ ownerId, mainSessionId: ownerId, requestId: envelope.requestId, operationId: envelope.operationId, outcome: 'submitted' })
    assert.throws(() => f.normal.acceptPrepared(request, f.exec), { code: 'material_not_delivered' })
    await f.deliver()
    assert.throws(() => f.normal.acceptPrepared({ ...request, target: { ...request.target, sourceVersion: 2 } }, f.exec), { code: 'stale_version' })
    assert.throws(() => f.normal.acceptPrepared({ ...request, target: { ...request.target, materialId: 'guessed' } }, f.exec), { code: 'not_found' })
    assert.throws(() => f.topics.requestOwned(ownerId, { kind: 'list_sessions' }, { ...f.exec, agent: { ...f.agent } }), { code: 'scope_mismatch' })
  } finally { await f.close() }
})

test('Host受理基础从冻结材料装配，重复业务操作只发一份短ACK请求并保留独立身份', async () => {
  const f = await fixture(); let waiting
  try {
    await f.deliver()
    const a = f.normal.acceptPrepared(request, f.exec), b = f.normal.acceptPrepared(structuredClone(request), f.exec)
    const frame = (await f.stream.next()).value
    assert.equal(frame.callId, f.exec.callId); assert.equal(frame.command.kind, 'normal_accept')
    assert.equal(frame.command.envelope.operationId, 'submission-operation-a'); assert.equal(frame.command.operationId, 'business-a')
    assert.equal(frame.command.envelope.material.sourceText, envelope.material.sourceText)
    const receipt = f.reply(frame); waiting = f.stream.next()
    assert.deepEqual(await a, receipt); assert.deepEqual(await b, receipt)
    assert.deepEqual(await f.normal.acceptPrepared(request, f.exec), receipt)
    assert.throws(() => f.normal.acceptPrepared({ ...request, organizedRequirements: 'Changed requirements' }, f.exec), { code: 'idempotency_conflict' })
    assert.throws(() => f.normal.acceptPrepared({ ...request, operationId: 'business-b' }, f.exec), { code: 'busy' })
  } finally { await f.close(waiting) }
})

test('Host受理基础未知ACK保留操作去重，不自动重发；实际错误回执可查询同一拒绝', async () => {
  const f = await fixture(); let waiting
  try {
    await f.deliver()
    const pending = f.normal.acceptPrepared(request, f.exec), denied = assert.rejects(pending, { code: 'outcome_unknown' })
    await f.stream.next(); waiting = f.stream.next()
    await f.close(waiting); await denied
  } finally { await f.close() }
})
