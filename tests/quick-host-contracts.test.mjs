import assert from 'node:assert/strict'
import test from 'node:test'
import { parseQuickRequest, parseQuickResult } from '../dist/shared/quick-translation.js'
import { DshTextExecutionAdapter } from '../dist/host/dsh-text-adapter.js'
import { QuickTranslationService } from '../dist/host/quick-translation.js'

const helpers = { createSystemMessage() {}, createUserMessage() {}, createAssistantMessage() {}, AssistantStreamAccumulator: class {}, BlockAssembler: class {} }
const route = { providerId: 'synthetic', modelId: 'model', configVersion: 0 }
const query = { sessionKey: 'quick:test', operationId: 'synthetic-operation' }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture(prepare = async config => ({ config, adapterDefaults: {}, async *stream() { throw new Error('No dispatch is expected') } })) {
  let dispatches = 0
  const service = new QuickTranslationService({ provide() {}, invocation: { peer: { id: 'synthetic-operator' } }, typertGateway: {},
    llm: { async listModels(provider) { return [{ provider, id: 'model' }] }, async resolveModelInfo(provider, id) { return { provider, id } }, prepareCall: prepare },
    sessions: { prepare() { dispatches++; throw new Error('No dispatch is expected') } },
  }, async () => helpers)
  return { service, get dispatches() { return dispatches } }
}
async function request(service, operationId = 'synthetic-operation') {
  const opened = await service.open({ localSessionId: 'opaque%legacy/session', maxSourceCodePoints: 5 })
  assert.equal(opened.ok, true)
  return { sessionKey: opened.value.sessionKey, operationId, draftVersion: 3, sourceText: 'hello', targetLanguage: '中文', instruction: '', model: route }
}

test('快译open兼容opaque legacy含%，RPC其余身份仍严格且额外字段拒绝', () => {
  const value = { localSessionId: 'legacy:%25/path with spaces', maxSourceCodePoints: 5 }
  assert.deepEqual(parseQuickRequest('open', value), value)
  assert.doesNotThrow(() => parseQuickRequest('open', { ...value, localSessionId: 'a'.repeat(2048) }))
  assert.throws(() => parseQuickRequest('open', { ...value, localSessionId: 'a'.repeat(2049) }))
  assert.throws(() => parseQuickRequest('status', { ...query, operationId: '%legacy' }))
  assert.throws(() => parseQuickRequest('submit', { ...query, draftVersion: 1, sourceText: 'x', targetLanguage: 'en', instruction: '', model: { ...route, tools: ['bad'] } }))
})

test('严格领域回执区分未受理running、0版本取消意图及完整完成，拒绝双层/畸形状态', () => {
  const result = state => ({ ok: true, value: { ...query, draftVersion: 1, accepted: false, status: 'running', text: '', ...state } })
  assert.doesNotThrow(() => parseQuickResult('submit', result({})))
  assert.doesNotThrow(() => parseQuickResult('cancel', result({ draftVersion: 0, status: 'cancelled' })))
  assert.throws(() => parseQuickResult('submit', result({ draftVersion: 0 })))
  assert.throws(() => parseQuickResult('submit', result({ status: 'unknown' })))
  assert.throws(() => parseQuickResult('submit', result({ accepted: true, status: 'completed' })))
  assert.throws(() => parseQuickResult('submit', result({ status: { toString() { return 'running' } } })))
  assert.throws(() => parseQuickResult('submit', { ok: true, value: result({}) }))
  assert.throws(() => parseQuickResult('submit', { ok: false, error: { code: 'invalid_input', message: '无效', stack: 'private' } }))
})

test('宿主缺执行服务降级，暂时模块加载失败后重新检查可恢复且并行ready共用一次加载', async () => {
  assert.equal(await new DshTextExecutionAdapter({}).ready(), false)
  const { service } = fixture(); let loads = 0
  const adapter = new DshTextExecutionAdapter(service.ctx, async () => { loads++; if (loads === 1) throw new Error('Transient module load'); return helpers })
  assert.deepEqual(await Promise.all([adapter.ready(), adapter.ready()]), [false, false])
  assert.equal(loads, 1)
  assert.equal(await adapter.ready(), true); assert.equal(loads, 2)
  assert.equal(await adapter.ready(), true); assert.equal(loads, 2)
  service.dispose()
})

test('Host准备前占用会话，同操作幂等；第二个请求和冲突载体不受理', async () => {
  const gate = deferred(); let prepares = 0
  const app = fixture(async config => { prepares++; await gate.promise; return { config, adapterDefaults: {} } })
  try {
    const body = await request(app.service); const submitting = app.service.submit(body); await tick()
    const duplicate = await app.service.submit(body)
    assert.equal(duplicate.value.accepted, false); assert.equal(duplicate.value.status, 'running')
    assert.equal((await app.service.submit({ ...body, operationId: 'second' })).error.code, 'busy')
    assert.equal((await app.service.submit({ ...body, sourceText: 'other' })).error.code, 'idempotency_conflict')
    assert.equal(prepares, 1)
    await app.service.cancel(body.sessionKey ? { sessionKey: body.sessionKey, operationId: body.operationId } : query)
    gate.resolve(); assert.equal((await submitting).value.status, 'cancelled'); assert.equal(app.dispatches, 0)
  } finally { gate.resolve(); app.service.dispose() }
})

test('Host取消意图阻止迟到submit，并绑定其草稿版本供status准确确认', async () => {
  let prepares = 0; const app = fixture(async () => { prepares++; throw new Error('No prepare is expected') })
  try {
    const body = await request(app.service); const identity = { sessionKey: body.sessionKey, operationId: body.operationId }
    assert.equal((await app.service.cancel(identity)).value.draftVersion, 0)
    const submitted = await app.service.submit(body)
    assert.equal(submitted.value.draftVersion, 3); assert.equal(submitted.value.status, 'cancelled'); assert.equal(submitted.value.accepted, false)
    assert.equal((await app.service.status(identity)).value.draftVersion, 3)
    assert.equal((await app.service.submit({ ...body, draftVersion: 4 })).error.code, 'idempotency_conflict')
    assert.equal(prepares, 0); assert.equal(app.dispatches, 0)
  } finally { app.service.dispose() }
})

test('Host准备错误只输出允许分类与阶段，provider正文/任意code/堆栈不得进入回执', async () => {
  const app = fixture(async () => { throw Object.assign(new Error('synthetic-secret-body'), { code: 'SYNTHETIC_SECRET_KEY' }) })
  try {
    const response = await app.service.submit(await request(app.service))
    assert.equal(response.value.status, 'failed'); assert.equal(response.value.accepted, false)
    assert.deepEqual(response.value.error, { code: 'EXECUTION_FAILED', message: '无法准备所选模型，请检查模型配置或更换模型。', stage: 'prepare' })
    assert.ok(!JSON.stringify(response).includes('synthetic-secret')); assert.ok(!JSON.stringify(response).includes('SYNTHETIC_SECRET_KEY'))
    assert.equal(app.dispatches, 0)
  } finally { app.service.dispose() }
})
test('submit可选稳定unitId兼容旧载体，额外字段及空/过长unitId拒绝', () => {
  const body = { ...query, draftVersion: 1, sourceText: 'x', targetLanguage: 'en', instruction: '', model: route }
  assert.deepEqual(parseQuickRequest('submit', body), body)
  assert.deepEqual(parseQuickRequest('submit', { ...body, unitId: 'stable:%opaque/unit' }), { ...body, unitId: 'stable:%opaque/unit' })
  assert.throws(() => parseQuickRequest('submit', { ...body, unitId: '' }))
  assert.throws(() => parseQuickRequest('submit', { ...body, unitId: 'a'.repeat(2049) }))
  assert.throws(() => parseQuickRequest('submit', { ...body, unitId: 'stable-unit', history: ['private'] }))
})

test('Host稳定unit映射用于targeted新operation，冻结材料、幂等单位身份且没有第二最终指针', async () => {
  let prepares = 0
  const app = fixture(async config => { prepares++; return { config, adapterDefaults: {}, async *stream() { throw new Error('Synthetic incomplete output') } } })
  app.service.adapter.execute = async function* () {
    yield { type: 'text', text: 'Synthetic translation' }
    yield { type: 'terminal', reason: 'stop', completeness: 'complete', checks_passed: true, provider_state: 'finished' }
  }
  const received = [], acceptances = []
  const receive = app.service.runtime.receive.bind(app.service.runtime), accept = app.service.runtime.accept.bind(app.service.runtime)
  app.service.runtime.receive = value => { received.push(structuredClone(value)); return receive(value) }
  app.service.runtime.accept = value => { const result = accept(value); if (result.ok) acceptances.push(result.value); return result }
  try {
    const initial = { ...await request(app.service), unitId: 'stable-user-unit' }
    assert.equal((await app.service.submit(initial)).value.accepted, true); await tick()
    assert.equal((await app.service.status({ sessionKey: initial.sessionKey, operationId: initial.operationId })).value.status, 'completed')
    assert.equal((await app.service.submit({ ...initial, operationId: 'synthetic-retranslation' })).value.accepted, true); await tick()
    assert.equal(received[1].trigger, 'explicit_revision'); assert.equal(received[1].target.unit_id, acceptances[0].unit_id)
    assert.equal(acceptances[1].unit_id, acceptances[0].unit_id); assert.equal(acceptances[1].candidate_order, 2)
    const snapshot = app.service.runtime.getSnapshot({ translation_session_id: received[0].translation_session_id })
    assert.equal(snapshot.value.units.length, 1); assert.equal(snapshot.value.units[0].final_pointer, null)
    assert.equal((await app.service.submit({ ...initial, operationId: 'synthetic-mismatch', sourceText: 'other' })).error.code, 'invalid_input')
    assert.equal((await app.service.submit({ ...initial, unitId: 'changed-unit' })).error.code, 'idempotency_conflict')
    assert.equal(prepares, 2)
  } finally { app.service.dispose() }
})
