import assert from 'node:assert/strict'
import test from 'node:test'
import { TranslationMaterialsService } from '../dist/host/translation-materials.js'
import { TRANSLATION_MATERIAL_REMOTE, parseTranslationMaterialRequest, parseTranslationMaterialResult } from '../dist/shared/translation-material-remote.js'

const scope = { ownerId: 'main-a', mainSessionId: 'main-a', requestId: 'request-a', operationId: 'operation-a' }
function material(scopePatch = {}, patch = {}) { return { ...scope, ...scopePatch, kind: 'material', material: {
  materialId: 'material-a', sourceVersion: 1, topicId: 'topic-a', translationSessionId: 'translation-a', draftVersion: 7,
  sourceText: 'Synthetic material A', targetLanguage: '中文', instruction: '', model: null, maxInputChars: 20000, ...patch,
} } }
function fixture() {
  const listeners = new Map(), cleanup = [], submitted = []
  const agent = { id: 'main-a', session: { id: 'main-a' }, inbox: { nextTurn: [], nextStep: [] }, followup(message) { submitted.push(message); this.inbox.nextTurn.push(message) } }
  const peer = { id: 'peer-a', ctx: { effect(register) { cleanup.push(register()) } } }
  const ctx = { invocation: { peer }, get(name) { return { agents: {}, sessionController: { resolveAgent: async () => ({ agent }) }, translationTopics: { ownsConnection: (ownerId, peerId) => ownerId === 'main-a' && peerId === 'peer-a' } }[name] },
    on(name, callback) { listeners.set(name, callback); return () => listeners.delete(name) } }
  let sequence = 0
  const service = new TranslationMaterialsService(ctx, async () => ({ createUserMessage: input => ({ ...input, id: `message-${++sequence}`, role: 'user' }) }))
  return { service, ctx, agent, submitted, cleanup, listeners, step(messages, decision = { kind: 'enter', messages }) {
    return listeners.get('agent/pre-step')({ agent, messages, signal: new AbortController().signal }, async () => decision)
  } }
}
function value(result) { assert.equal(result.ok, true); return result.value }

test('Host只对已准备的exact rpc添加独立notice，原命令与downstream reject保持原样', async () => {
  const f = fixture(), envelope = material()
  assert.equal(value(await f.service.capabilities()).directSubmit, true)
  assert.equal(value(f.service.prepare(envelope)).stage, 'prepared')
  const main = { id: 'main-message', role: 'user', source: { kind: 'user', rpcId: scope.requestId }, content: [{ type: 'text', text: 'Explain before translating' }] }
  const other = { ...main, id: 'other-message', source: { kind: 'user', rpcId: 'other-request' } }
  const rejected = { kind: 'reject', reason: 'synthetic downstream rejection' }
  assert.equal(await f.step([main], rejected), rejected)
  const entered = await f.step([other, main])
  assert.equal(entered.messages[0], other); assert.equal(entered.messages[1], main)
  assert.equal(entered.messages[2].source.kind, 'translation-material')
  assert.equal(entered.messages[2].source.form, 'notice')
  assert.equal(entered.messages[2].source.summary, '待译材料')
  assert.equal(entered.messages[2].source.mainSessionId, scope.mainSessionId)
  assert.equal(entered.messages[2].source.sourceVersion, 1)
  assert.ok(entered.messages[2].content[0].text.includes('Synthetic material A'))
  assert.equal(value(f.service.query(scope)).receipt.stage, 'attached')
  assert.deepEqual(main.content, [{ type: 'text', text: 'Explain before translating' }])
  assert.equal((await f.step([main])).messages.length, 1)
  f.service.dispose()
})

test('none/omit与未准备消息正常通过；owner/peer和重复正文冲突不替换快照', async () => {
  const f = fixture(), main = { id: 'main', role: 'user', source: { kind: 'user', rpcId: scope.requestId }, content: [] }
  assert.equal((await f.step([main])).messages.length, 1)
  for (const kind of ['none', 'omit']) {
    value(f.service.prepare({ ...scope, kind }))
    assert.equal((await f.step([main])).messages.length, 1)
    assert.equal(value(f.service.release(scope)).released, true)
  }
  value(f.service.prepare(material()))
  assert.equal(f.service.prepare(material({}, { sourceText: 'Different body' })).error.code, 'idempotency_conflict')
  f.ctx.invocation = { peer: { id: 'peer-b' } }
  assert.equal(f.service.prepare(material()).error.code, 'scope_mismatch')
  f.ctx.invocation = { peer: { id: 'peer-a' } }
  assert.equal(value(f.service.query(scope)).snapshot.material.sourceText, 'Synthetic material A')
  f.service.dispose()
})

test('直发仅接受material，重复请求一次followup，返回主准入而不变成翻译完成', async () => {
  const f = fixture(), signal = new AbortController().signal
  assert.equal((await f.service.submit({ ...scope, kind: 'none' }, signal)).error.stage, 'prepare')
  const [a, b] = await Promise.all([f.service.submit(material(), signal), f.service.submit(material(), signal)])
  assert.deepEqual(value(a), value(b)); assert.equal(value(a).stage, 'submitted')
  assert.equal(f.submitted.length, 1)
  assert.equal(f.submitted[0].source.kind, 'translation-material')
  assert.equal(f.submitted[0].source.requestId, scope.requestId)
  assert.equal(f.submitted[0].source.operationId, scope.operationId)
  assert.equal(f.submitted[0].source.rpcId, undefined)
  assert.ok(f.submitted[0].content[0].text.includes('no separate main-chat command'))
  f.service.dispose()
})

test('unknown保留，连接关闭只释放未准入材料；队列编辑/steer保留，删除释放', async () => {
  const f = fixture()
  value(f.service.prepare(material()))
  value(f.service.finish({ ...scope, outcome: 'unknown' }))
  f.service.releaseConnection('main-a', 'peer-a')
  assert.equal(value(f.service.query(scope)).receipt.stage, 'unknown')
  value(f.service.release(scope))
  value(f.service.prepare(material()))
  f.service.releaseConnection('main-a', 'peer-a')
  assert.equal(value(f.service.query(scope)), null)
  value(f.service.prepare(material()))
  const message = { id: 'queued-message', role: 'user', source: { kind: 'user', rpcId: scope.requestId }, content: [] }
  f.listeners.get('agent/inbox/inserted')({ agent: f.agent, message })
  f.service.releaseConnection('main-a', 'peer-a')
  assert.equal(value(f.service.query(scope)).receipt.stage, 'submitted')
  f.listeners.get('agent/inbox/discarded')({ agent: f.agent, message })
  f.agent.inbox.nextStep.push(message)
  await Promise.resolve()
  assert.ok(value(f.service.query(scope)))
  f.agent.inbox.nextStep.length = 0
  f.listeners.get('agent/inbox/discarded')({ agent: f.agent, message })
  await Promise.resolve()
  assert.equal(value(f.service.query(scope)), null)
  value(f.service.prepare(material()))
  f.cleanup.forEach(cleanup => cleanup())
  assert.equal(value(f.service.query(scope)), null)
  f.service.dispose()
})

test('直发异步解析后使用入口实际peer，动态invocation消失不冒充连接变更', async () => {
  const f = fixture(), get = f.ctx.get
  let resolved
  const agent = new Promise(resolve => { resolved = resolve })
  f.ctx.get = name => name === 'sessionController' ? { resolveAgent: () => agent } : get(name)
  const pending = f.service.submit(material(), new AbortController().signal)
  f.ctx.invocation = undefined
  resolved({ agent: f.agent })
  assert.equal(value(await pending).stage, 'submitted')
  assert.equal(f.submitted.length, 1)
  assert.equal(f.submitted[0].source.requestId, scope.requestId)
  f.service.dispose()
})

test('新Remote只解析明确材料协议，查询缺失保持null且结果保留错误阶段', () => {
  assert.equal(TRANSLATION_MATERIAL_REMOTE.descriptors.length, 6)
  assert.deepEqual(parseTranslationMaterialRequest('prepare', material()), material())
  assert.deepEqual(parseTranslationMaterialRequest('finish', { ...scope, outcome: 'unknown' }), { ...scope, outcome: 'unknown' })
  assert.deepEqual(parseTranslationMaterialResult('query', { ok: true, value: null }), { ok: true, value: null })
  const failed = { ok: false, error: { code: 'unavailable', message: 'Synthetic unavailable', stage: 'resolve_main_agent' } }
  assert.deepEqual(parseTranslationMaterialResult('submit', failed), failed)
  assert.throws(() => parseTranslationMaterialRequest('prepare', { ...material(), mainCommand: 'Hidden command' }), TypeError)
  assert.throws(() => parseTranslationMaterialResult('prepare', { ok: true, value: { ...scope, kind: 'material', stage: 'translation_completed' } }), TypeError)
})
