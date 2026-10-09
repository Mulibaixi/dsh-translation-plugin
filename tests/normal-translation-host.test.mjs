import assert from 'node:assert/strict'
import test from 'node:test'
import { NormalTranslationService } from '../dist/host/normal-translation.js'
import { TranslationMaterialsService } from '../dist/host/translation-materials.js'
import { TranslationSourcesService } from '../dist/host/translation-sources.js'
import { TopicToolsService } from '../dist/host/topic-tools.js'
import { parseNormalTranslationExecute, parseNormalTranslationSourceCorrection } from '../dist/shared/normal-translation.js'
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
      sessionController: { list: async () => ({ items: [{ sessionId: ownerId }] }), resolveAgent: async () => ({ agent }) } }[name] },
    on(name, listener) { const listeners = hooks.get(name) ?? []; listeners.push(listener); hooks.set(name, listeners); return () => {} },
  }
  const topics = services.translationTopics = new TopicToolsService(ctx, async () => ({ defineTool: options => options }), 1000)
  const materials = services.translationMaterials = new TranslationMaterialsService(ctx, async () => ({ createUserMessage: input => ({ ...input, id: 'synthetic-material-message', role: 'user' }) }))
  const normal = services.translationNormal = new NormalTranslationService(ctx)
  const controller = new AbortController(), stream = topics.connect({ ownerId, mainSessionId: ownerId }, controller.signal)
  await stream.next()
  const exec = { agent, callId: 'actual-main-tool-call', signal: new AbortController().signal }
  return { normal, materials, topics, stream, uplink, registered, agent, exec, ctx, services,
    async deliver(input = envelope) {
      assert.equal(materials.prepare(input).ok, true)
      const message = { id: 'synthetic-main-message', role: 'user', source: { kind: 'user', rpcId: input.requestId }, content: [] }
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

test('已交付文件在普通execute和prepared受理前明确requires_batch，不创建job或访问译模型', async () => {
  const f = await fixture(), bytes = Buffer.from('Synthetic file beyond the single-call limit')
  f.services.fileUploads = { resolve: () => ({ attachmentId: 'synthetic-file', name: 'synthetic.txt', bytes: bytes.length }) }
  f.services.attachments = { async *readFileStream() { yield bytes } }
  const sources = f.services.translationSources = new TranslationSourcesService(f.ctx)
  try {
    const imported = await sources.importReceipt({ scope: { ownerId, mainSessionId: ownerId, topicId: 'topic-a', translationSessionId: 'translation-a' },
      receiptId: 'synthetic-file-receipt', idempotencyKey: 'synthetic-import' }, f.exec.signal)
    assert.equal(imported.ok, true)
    const file = structuredClone(envelope); delete file.material.sourceText
    file.material.sourceRef = imported.value; file.material.maxInputChars = 1
    let modelChecks = 0, businessRequests = 0
    f.normal.adapter.ready = async () => { modelChecks++; return true }
    const originalRequest = f.topics.requestOwned.bind(f.topics)
    f.topics.requestOwned = (...args) => { businessRequests++; return originalRequest(...args) }
    await f.deliver(file)
    assert.throws(() => f.normal.execute(request, f.exec), { code: 'requires_batch', stage: 'prepare' })
    assert.throws(() => f.normal.acceptPrepared(request, f.exec), { code: 'requires_batch', stage: 'prepare' })
    assert.equal(modelChecks, 0); assert.equal(businessRequests, 0)
    assert.equal(f.normal.jobs.size, 0); assert.equal(f.normal.admissions.size, 0); assert.equal(f.normal.activeSessions.size, 0)
    assert.deepEqual(f.materials.deliveredForAgent(request.target, f.agent).value, file)
  } finally { sources.dispose(); await f.close() }
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

const unitTarget = { kind: 'unit', mainSessionId: ownerId, translationSessionId: 'translation-a', unitId: 'client-authority-unit-a', sourceVersion: 1 }
test('历史重译与源纠错协议要求明确单元和预期版本，source/revision事实兼容旧版1', () => {
  assert.deepEqual(parseNormalTranslationExecute({ ...request, target: unitTarget }), { ...request, target: unitTarget })
  const correction = { target: unitTarget, operationId: 'correct-source-a', sourceText: 'Synthetic corrected source', reason: '' }
  assert.deepEqual(parseNormalTranslationSourceCorrection(correction), correction)
  assert.throws(() => parseNormalTranslationSourceCorrection({ ...correction, target: request.target }))
  assert.throws(() => parseNormalTranslationExecute({ ...request, target: unitTarget, sourceText: 'Replacement outside correction' }))
  const fact = { id: unitTarget.unitId, order: 1, source: 'Synthetic current source', targetLanguage: '中文', instruction: '', revisions: [], final: null }
  assert.equal(parseTopicBridgeReply({ requestId: 'r', ok: true, value: { kind: 'unit', unit: fact } }).value.unit.sourceVersion, 1)
  assert.equal(parseTopicBridgeReply({ requestId: 'r', ok: true, value: { kind: 'unit', unit: { ...fact, sourceVersion: 2 } } }).value.unit.sourceVersion, 2)
})

test('Host纠错经Client短ACK保持独立operation，重复不再发请求且不调用provider', async () => {
  const f = await fixture(); let waiting
  try {
    const correction = { target: unitTarget, operationId: 'source-correction-a', sourceText: 'Synthetic corrected source', reason: 'Synthetic correction' }
    assert.throws(() => f.normal.correctSource(correction, { ...f.exec, agent: { ...f.agent } }), { code: 'scope_mismatch' })
    const a = f.normal.correctSource(correction, f.exec), b = f.normal.correctSource(correction, f.exec), frame = (await f.stream.next()).value
    assert.deepEqual(frame.command, { kind: 'normal_correct_source', ...correction })
    const receipt = { operationId: correction.operationId, mainSessionId: ownerId, translationSessionId: unitTarget.translationSessionId,
      unitId: unitTarget.unitId, previousSourceVersion: 1, sourceVersion: 2, persistence: 'runtime_only' }
    f.uplink.push(parseTopicBridgeReply({ requestId: frame.requestId, ok: true, value: { kind: 'normal_source_corrected', correction: receipt } }))
    waiting = f.stream.next()
    assert.deepEqual(await a, receipt); assert.deepEqual(await b, receipt)
    assert.deepEqual(await f.normal.correctSource(correction, f.exec), receipt)
    assert.throws(() => f.normal.correctSource({ ...correction, sourceText: 'Changed correction' }, f.exec), { code: 'idempotency_conflict' })
    assert.throws(() => f.normal.execute({ ...request, target: unitTarget, operationId: correction.operationId }, f.exec), { code: 'idempotency_conflict' })
  } finally { await f.close(waiting) }
})

test('Host历史重译先受控读取Client当前路由，模型不可用时不受理不消费材料', async () => {
  const f = await fixture(); let waiting
  try {
    const retranslate = { ...request, target: unitTarget, operationId: 'retranslate-existing-a' }
    const execution = f.normal.execute(retranslate, f.exec), rejected = assert.rejects(execution, { code: 'execution_unavailable' })
    const frame = (await f.stream.next()).value
    assert.deepEqual(frame.command, { kind: 'normal_resolve', target: unitTarget, operationId: retranslate.operationId })
    const resolved = { ...envelope, requestId: 'unit-freeze-a', material: { ...envelope.material, unitReference: { unitId: unitTarget.unitId, sourceVersion: 1 }, model: { provider: 'synthetic-current', model: 'current-route', reasoningEffort: 'low' } } }
    f.uplink.push(parseTopicBridgeReply({ requestId: frame.requestId, ok: true, value: { kind: 'normal_resolved', envelope: resolved } }))
    waiting = f.stream.next(); await rejected
    await assert.rejects(f.normal.execute(retranslate, f.exec), { code: 'execution_unavailable' })
  } finally { await f.close(waiting) }
})
