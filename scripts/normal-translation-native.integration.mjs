import assert from 'node:assert/strict'
import test from 'node:test'
import { createTopicToolsNativeFixture, waitTopicReady } from '../tests/topic-tools-native-fixture.mjs'
import { SessionStore } from '../dist/client/session-store.js'
import { TopicMemoryStore } from '../dist/client/topic-memory-store.js'
import { TopicArchiveStore } from '../dist/client/topic-archive-store.js'
import { MaterialSubmissionsClient } from '../dist/client/material-submissions.js'
import { NormalTranslationClient } from '../dist/client/normal-translation.js'

const runtimeRoot = process.env.DSH_RUNTIME_ROOT
if (!runtimeRoot) throw new Error('DSH_RUNTIME_ROOT is required for the actual Native Tools/Agent/Gateway components')
const mainId = 'synthetic-normal-native-main'
const tick = () => new Promise(resolve => setTimeout(resolve, 5))
async function waitFor(predicate, details = () => undefined) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await tick() }
  throw new Error(`Native normal condition did not settle: ${JSON.stringify(details())}`)
}
function executionDetails(t, p) {
  return { mainCalls: p.mainCalls, translationCalls: p.translationCalls, bridge: t.bridge.getStatus(mainId),
    replies: t.f.replies.filter(reply => !reply.ok),
    updates: t.f.requests.filter(frame => frame.command.kind === 'normal_update').map(frame => ({
      sequence: frame.command.sequence, status: frame.command.status, model: frame.command.metadata?.model })),
    states: t.store.getTranslationHistory(t.session.id).units.map(unit => ({ id: unit.id,
      operation: t.normal.getUnitStatus(t.session.id, unit.id), revisions: unit.revisions.map(revision => ({ status: revision.status, model: revision.callRecord?.model })) })) }
}
function value(response) { assert.equal(response.ok, true, JSON.stringify(response)); assert.equal(response.value.ok, true, JSON.stringify(response)); return response.value.value }
async function fixture({ dropAcceptance = false } = {}) {
  const f = await createTopicToolsNativeFixture({ runtimeRoot })
  f.host.provider.catalog = ['model-a', 'model-b', 'model-c']
  if (dropAcceptance) {
    const original = f.client.connection.rpc.open
    let dropped = false
    f.client.connection.rpc.open = (path, endpoint, payload, signal, uplink) => original(path, endpoint, payload, signal, {
      async *[Symbol.asyncIterator]() {
        for await (const reply of uplink) {
          if (!dropped && reply.ok && reply.value.kind === 'normal_operation') { dropped = true; throw new Error('Synthetic acceptance ACK loss') }
          yield reply
        }
      },
    })
  }
  const main = await f.createAgent(mainId), store = new SessionStore(), session = store.createSession(mainId)
  store.updateSession(session.id, { mode: 'normal', input: 'Synthetic source A', model: { provider: 'synthetic', model: 'model-b' } })
  const terms = new TopicMemoryStore(store), archive = new TopicArchiveStore(store, (sessionId, unitId) => terms.readEvidence(sessionId, unitId))
  const bridge = f.bridge(store, terms, archive), release = bridge.retain(mainId)
  const materials = new MaterialSubmissionsClient({ store, topics: bridge, remote: f.client.remote.translationMaterials,
    owner: {}, registry: { register: () => () => {} } })
  const normal = new NormalTranslationClient(store, materials, terms, ownerId => bridge.retain(ownerId), { remote: f.client.remote.translationNormal,
    canAccessUnit: (ownerId, sessionId, unitId) => bridge.isPublished(ownerId, sessionId, unitId),
    subscribeBridge: listener => bridge.subscribe(listener), bridgeReady: ownerId => bridge.getStatus(ownerId).ready })
  bridge.setNormalTranslation(normal)
  await waitTopicReady(bridge, mainId, f.carrierErrors); await materials.load()
  const send = async () => {
    assert.equal(materials.getStatus(session.id).blocked, undefined)
    await materials.send(session.id); await main.agent.whenIdle()
    const notice = f.host.provider.calls[0].messages.find(message => message.source.kind === 'translation-material')
    return JSON.parse(notice.content[0].text.split('\n').at(-1))
  }
  const executeRequest = envelope => ({ target: { kind: 'material', mainSessionId: mainId, requestId: envelope.requestId,
    materialId: envelope.material.materialId, sourceVersion: envelope.material.sourceVersion }, operationId: 'native-normal-business', organizedRequirements: '', termReferences: [] })
  return { f, main, store, session, terms, materials, bridge, normal, send, executeRequest,
    async close() { normal.dispose(); materials.dispose(); release(); await main.dispose(); archive.dispose(); terms.dispose(); store.dispose(); await f.close() } }
}

test('Native普通执行缺模型时明确拒绝，主Agent正常讨论不消费材料或建立单元', async () => {
  const t = await fixture()
  try {
    t.store.updateSession(t.session.id, { model: null })
    const envelope = await t.send(), request = t.executeRequest(envelope), calls = t.f.host.provider.calls.length
    const result = await t.f.host.ctx.tools.execute({ agent: t.main.agent, name: 'translation_execute', arguments: request,
      callId: 'native-normal-gated-call', signal: new AbortController().signal })
    assert.equal(result.isError, true); assert.ok(JSON.stringify(result).includes('未选择翻译模型'))
    assert.equal(t.f.requests.filter(frame => frame.command.kind === 'normal_accept').length, 0)
    assert.equal(t.f.host.provider.calls.length, calls)
    assert.equal(t.store.getTranslationHistory(t.session.id).units.length, 0)
    assert.equal(t.store.getSession(t.session.id).input, 'Synthetic source A')
    assert.equal(t.f.host.ctx.translationMaterials.deliveredForAgent(request.target, t.main.agent).ok, true)
  } finally { await t.close() }
})

test('Native 2A Host受理基础经正式Gateway取得Client短ACK，去重保留A源和后改B并自动授权读取', async () => {
  const t = await fixture()
  try {
    const envelope = await t.send(), request = t.executeRequest(envelope)
    t.store.updateSession(t.session.id, { input: 'Synthetic edited draft B' })
    const exec = { agent: t.main.agent, callId: 'native-normal-foundation', signal: new AbortController().signal }
    const [a, b] = await Promise.all([t.f.host.ctx.translationNormal.acceptPrepared(request, exec), t.f.host.ctx.translationNormal.acceptPrepared(request, exec)])
    assert.deepEqual(a, b); assert.equal(a.operation.status, 'accepted'); assert.equal(a.operation.operationId, request.operationId)
    assert.equal(t.f.requests.filter(frame => frame.command.kind === 'normal_accept').length, 1)
    assert.equal(t.f.replies.filter(reply => reply.ok && reply.value.kind === 'normal_operation').length, 1)
    const history = t.store.getTranslationHistory(t.session.id)
    assert.equal(history.units.length, 1); assert.equal(history.units[0].source, 'Synthetic source A'); assert.equal(history.units[0].revisions.length, 0)
    assert.equal(t.store.getSession(t.session.id).input, 'Synthetic edited draft B')
    const read = await t.f.host.ctx.tools.execute({ agent: t.main.agent, name: 'translation_read_unit', arguments: { translationSessionId: t.session.id,
      unitId: a.operation.unitId }, callId: 'native-normal-authorized-read', signal: new AbortController().signal })
    assert.equal(read.isError, false); assert.equal(read.value.unit.source, 'Synthetic source A')
    assert.equal(t.f.host.provider.calls.length, 1, 'only the main discussion called the synthetic provider; foundation acceptance does not translate')
  } finally { await t.close() }
})

function installExecutionProvider(t, { gate = false } = {}) {
  let mainCalls = 0, translationCalls = 0, request, resumeTranslation
  const issued = new Set(), tools = []
  t.f.host.provider.stream = async function* (options) {
    this.calls.push(options)
    if (options.model === 'model-b' || options.model === 'model-c') {
      translationCalls++
      assert.equal(t.store.getTranslationHistory(t.session.id).units.length, 1, 'Client acceptance precedes translator dispatch')
      assert.deepEqual(options.tools, [])
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '合成译文' }
      if (gate) await new Promise(resolve => { resumeTranslation = resolve; if (options.signal.aborted) resolve(); else options.signal.addEventListener('abort', resolve, { once: true }) })
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '合成译文' } }
      yield { type: 'usage', usage: { inputTokens: 13, outputTokens: 4 } }
      yield { type: 'finish', reason: { kind: options.signal.aborted ? 'aborted' : 'stop' } }
      return
    }
    mainCalls++
    const unitNotice = options.messages.findLast(message => message.source.kind === 'translation-unit')
    const unitRequest = unitNotice ? JSON.parse(unitNotice.content[0].text.split('\n').at(-1)) : undefined
    const queued = tools.shift()
    if (queued || mainCalls === 1 || (unitRequest && !issued.has(unitRequest.operationId))) {
      let name = 'translation_execute', args
      if (queued) { name = queued.name; args = queued.arguments }
      else if (unitRequest) args = { ...unitRequest, organizedRequirements: '', termReferences: [] }
      else {
      const notice = options.messages.find(message => message.source.kind === 'translation-material')
      const envelope = JSON.parse(notice.content[0].text.split('\n').at(-1))
        args = t.executeRequest(envelope)
      }
      request = args; issued.add(args.operationId)
      const call = { type: 'tool-call', id: `native-main-tool-call:${mainCalls}`, name, arguments: JSON.stringify(args) }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments }
      yield { type: 'block-end', index: 0, block: call }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Synthetic acceptance received' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Synthetic acceptance received' } }
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  return { get request() { return request }, get mainCalls() { return mainCalls }, get translationCalls() { return translationCalls },
    enqueueTool(name, args) { tools.push({ name, arguments: args }) }, finishTranslation() { resumeTranslation?.() } }
}

test('Native真实主Agent tool-call→Gateway→Client受理→独立译模型流式回写，重复不调用provider且旧A回原会话', async () => {
  const t = await fixture(), p = installExecutionProvider(t)
  try {
    await t.materials.send(t.session.id)
    t.store.updateSession(t.session.id, { input: 'Synthetic edited B', targetLanguage: 'English', model: { provider: 'synthetic', model: 'model-a' } })
    const next = t.store.createSession(mainId); t.store.updateSession(next.id, { mode: 'normal', input: 'Synthetic unrelated draft' })
    await t.main.agent.whenIdle()
    await waitFor(() => t.store.getTranslationHistory(t.session.id).units[0]?.revisions[0]?.status === 'completed', () => executionDetails(t, p))
    const unit = t.store.getTranslationHistory(t.session.id).units[0], revision = unit.revisions[0]
    assert.equal(unit.source, 'Synthetic source A'); assert.equal(unit.targetLanguage, '中文'); assert.equal(revision.text, '合成译文')
    assert.equal(revision.operationId, p.request.operationId); assert.notEqual(revision.id, revision.operationId)
    assert.equal(revision.callRecord.promptVersion, 'normal-text-v1'); assert.equal(revision.callRecord.model.model, 'model-b')
    assert.equal(t.store.getSession(t.session.id).input, 'Synthetic edited B'); assert.equal(t.store.getTranslationHistory(next.id).units.length, 0)
    assert.equal(p.mainCalls, 2); assert.equal(p.translationCalls, 1)
    const duplicate = await t.f.host.ctx.tools.execute({ agent: t.main.agent, name: 'translation_execute', arguments: p.request,
      callId: 'native-duplicate-execution', signal: new AbortController().signal })
    assert.equal(duplicate.isError, false); assert.equal(duplicate.value.unitId, unit.id); assert.equal(p.translationCalls, 1)
    assert.equal(t.f.requests.filter(frame => frame.command.kind === 'normal_accept').length, 1)
    const translator = t.f.host.provider.calls.find(call => call.model === 'model-b')
    assert.equal(translator.messages.length, 2)
    assert.ok(!JSON.stringify(translator.messages).includes('Synthetic edited B'))
    const job = value(await t.f.client.remote.translationNormal.status({ mainSessionId: mainId, translationSessionId: t.session.id,
      operationId: p.request.operationId, afterSequence: 0 }))
    assert.equal(job.status, 'completed'); assert.equal(job.callId, revision.id); assert.ok(job.updates.length >= 3)
  } finally { await t.close() }
})

test('Native独立后台控制器：主工具已返回仍可正式取消，保留不完整译文且查询不重跑', async () => {
  const t = await fixture(), p = installExecutionProvider(t, { gate: true })
  try {
    await t.materials.send(t.session.id); await t.main.agent.whenIdle()
    await waitFor(() => t.store.getTranslationHistory(t.session.id).units[0]?.revisions[0]?.text === '合成译文', () => executionDetails(t, p))
    value(await t.f.client.remote.translationNormal.cancel({ mainSessionId: mainId, translationSessionId: t.session.id,
      operationId: p.request.operationId, afterSequence: 0 }))
    await waitFor(() => t.store.getTranslationHistory(t.session.id).units[0]?.revisions[0]?.status === 'cancelled')
    const unit = t.store.getTranslationHistory(t.session.id).units[0]
    assert.equal(unit.revisions[0].text, '合成译文'); assert.equal(unit.final, null); assert.equal(p.translationCalls, 1)
    assert.equal(value(await t.f.client.remote.translationNormal.status({ mainSessionId: mainId, translationSessionId: t.session.id,
      operationId: p.request.operationId, afterSequence: 0 })).status, 'cancelled')
    assert.equal(p.translationCalls, 1)
  } finally { await t.close() }
})

test('Native Client已经受理但ACK丢失，只读观察恢复零call失败，不重复消费或调用译provider', async () => {
  const t = await fixture({ dropAcceptance: true }), p = installExecutionProvider(t)
  try {
    await t.materials.send(t.session.id); await t.main.agent.whenIdle()
    await waitFor(() => !t.bridge.getStatus(mainId).ready)
    const unit = t.store.getTranslationHistory(t.session.id).units[0]
    assert.ok(unit); assert.equal(unit.revisions.length, 0); assert.equal(t.store.getSession(t.session.id).input, '')
    assert.equal(p.translationCalls, 0)
    await t.bridge.reset(mainId); await waitTopicReady(t.bridge, mainId, t.f.carrierErrors)
    const job = value(await t.f.client.remote.translationNormal.status({ mainSessionId: mainId, translationSessionId: t.session.id,
      operationId: p.request.operationId, afterSequence: 0 }))
    assert.equal(job.status, 'failed'); assert.equal(job.callId, null); assert.equal(job.error.code, 'EXECUTION_NOT_STARTED')
    await t.normal.query(t.session.id, unit.id)
    assert.equal(t.store.getTranslationHistory(t.session.id).units[0].revisions.length, 0)
    assert.equal(p.translationCalls, 0); assert.equal(t.f.requests.filter(frame => frame.command.kind === 'normal_accept').length, 1)
    assert.ok(t.f.requests.some(frame => frame.command.kind === 'normal_observe'))
  } finally { await t.close() }
})

test('Native单元重译由一次RPC进入真实主Agent，冻结当前模型和effort、不新增单元、不清草稿', async () => {
  const t = await fixture(), p = installExecutionProvider(t)
  try {
    await t.materials.send(t.session.id); await t.main.agent.whenIdle()
    await waitFor(() => t.store.getTranslationHistory(t.session.id).units[0]?.revisions[0]?.status === 'completed', () => executionDetails(t, p))
    const unit = t.store.getTranslationHistory(t.session.id).units[0]
    t.store.updateSession(t.session.id, { input: 'Synthetic unrelated draft B', targetLanguage: 'English', model: { provider: 'synthetic', model: 'model-c', reasoningEffort: 'low' } })
    const submission = { target: { kind: 'unit', mainSessionId: mainId, translationSessionId: t.session.id, unitId: unit.id, sourceVersion: 1 }, operationId: 'native-unit-retranslate' }
    const resolve = t.normal.resolve
    let frozenRoute = false
    t.normal.resolve = function (ownerId, input) {
      const result = resolve.call(this, ownerId, input)
      if (input.operationId === submission.operationId && result.ok) {
        frozenRoute = true
        t.store.updateSession(t.session.id, { model: { provider: 'synthetic', model: 'model-b' } })
      }
      return result
    }
    assert.equal(value(await t.f.client.remote.translationNormal.requestUnit(submission)).status, 'submitted')
    await t.main.agent.whenIdle()
    await waitFor(() => t.store.getTranslationHistory(t.session.id).units[0]?.revisions[1]?.status === 'completed', () => executionDetails(t, p))
    const history = t.store.getTranslationHistory(t.session.id), latest = history.units[0].revisions[1]
    assert.equal(history.units.length, 1); assert.equal(history.units[0].sourceVersion, 1); assert.equal(latest.sourceVersion, 1)
    assert.equal(latest.callRecord.model.model, 'model-c'); assert.equal(latest.callRecord.model.reasoningEffort, 'low')
    assert.equal(frozenRoute, true); assert.equal(t.store.getSession(t.session.id).model.model, 'model-b')
    assert.equal(history.units[0].targetLanguage, '中文'); assert.equal(t.store.getSession(t.session.id).input, 'Synthetic unrelated draft B')
    const mainCalls = p.mainCalls
    assert.equal(value(await t.f.client.remote.translationNormal.requestUnit(submission)).status, 'submitted')
    assert.equal(p.mainCalls, mainCalls); assert.equal(p.translationCalls, 2)
    assert.equal(t.f.requests.filter(frame => frame.command.kind === 'normal_accept').length, 2)
    p.enqueueTool('translation_correct_source', { target: submission.target, operationId: 'native-correct-and-translate-source', sourceText: 'Synthetic corrected and translated source v2', reason: '' })
    p.enqueueTool('translation_execute', { target: { ...submission.target, sourceVersion: 2 }, operationId: 'native-correct-and-translate-call', organizedRequirements: '', termReferences: [] })
    const llm = await t.f.host.native('@deepseek-ai/dsh-llm')
    t.main.agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'Synthetic user requests correction and retranslation in this one turn.' }], source: { kind: 'user' } }))
    await t.main.agent.whenIdle()
    await waitFor(() => t.store.getTranslationHistory(t.session.id).units[0]?.revisions[2]?.status === 'completed', () => executionDetails(t, p))
    const corrected = t.store.getTranslationHistory(t.session.id).units[0]
    assert.equal(corrected.sourceVersion, 2); assert.equal(corrected.sourceVersions.length, 2); assert.equal(corrected.revisions[2].sourceVersion, 2)
    assert.equal(corrected.revisions[0].sourceVersion, 1); assert.equal(corrected.revisions[1].sourceVersion, 1)
    assert.equal(corrected.revisions[2].callRecord.model.model, 'model-b'); assert.equal(p.translationCalls, 3)
    assert.equal(t.store.getSession(t.session.id).input, 'Synthetic unrelated draft B')
  } finally { await t.close() }
})

test('Native真实主Agent源纠错只增版本，旧调用晚到写旧版而不选新final，纠错后模型准备失败保留事实', async () => {
  const t = await fixture(), p = installExecutionProvider(t, { gate: true })
  try {
    await t.materials.send(t.session.id); await t.main.agent.whenIdle()
    await waitFor(() => t.store.getTranslationHistory(t.session.id).units[0]?.revisions[0]?.text === '合成译文', () => executionDetails(t, p))
    const unit = t.store.getTranslationHistory(t.session.id).units[0], target = { kind: 'unit', mainSessionId: mainId, translationSessionId: t.session.id,
      unitId: unit.id, sourceVersion: 1 }
    const correction = { target, operationId: 'native-source-correction', sourceText: 'Synthetic corrected source v2', reason: 'Synthetic correction' }
    p.enqueueTool('translation_correct_source', correction)
    const llm = await t.f.host.native('@deepseek-ai/dsh-llm')
    t.main.agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'Synthetic user requests correction of the provided unit.' }], source: { kind: 'user' } }))
    await t.main.agent.whenIdle()
    let current = t.store.getTranslationHistory(t.session.id).units[0]
    assert.equal(current.sourceVersion, 2); assert.equal(current.source, correction.sourceText); assert.equal(current.sourceVersions[0].text, 'Synthetic source A')
    const duplicate = await t.f.host.ctx.tools.execute({ agent: t.main.agent, name: 'translation_correct_source', arguments: correction,
      callId: 'native-duplicate-correction', signal: new AbortController().signal })
    assert.equal(duplicate.isError, false); assert.equal(duplicate.value.sourceVersion, 2)
    assert.equal(t.f.requests.filter(frame => frame.command.kind === 'normal_correct_source').length, 1)
    p.finishTranslation()
    await waitFor(() => t.store.getTranslationHistory(t.session.id).units[0].revisions[0].status === 'completed', () => executionDetails(t, p))
    current = t.store.getTranslationHistory(t.session.id).units[0]
    assert.equal(current.revisions[0].sourceVersion, 1); assert.equal(current.final, null)
    const read = await t.f.host.ctx.tools.execute({ agent: t.main.agent, name: 'translation_read_unit', arguments: { translationSessionId: t.session.id, unitId: unit.id },
      callId: 'native-current-source-read', signal: new AbortController().signal })
    assert.equal(read.value.unit.sourceVersion, 2); assert.equal(read.value.unit.revisions[0].sourceVersion, 1)
    t.store.updateSession(t.session.id, { model: null, input: 'Synthetic draft B remains' })
    p.enqueueTool('translation_execute', { target: { ...target, sourceVersion: 2 }, operationId: 'native-corrected-prepare-fail', organizedRequirements: '', termReferences: [] })
    t.main.agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'Synthetic user requests retranslation of corrected source.' }], source: { kind: 'user' } }))
    await t.main.agent.whenIdle()
    current = t.store.getTranslationHistory(t.session.id).units[0]
    assert.equal(current.sourceVersion, 2); assert.equal(current.revisions.length, 1); assert.equal(p.translationCalls, 1)
    assert.equal(t.store.getSession(t.session.id).input, 'Synthetic draft B remains')
    assert.equal(t.f.requests.filter(frame => frame.command.kind === 'normal_accept').length, 1)
  } finally { p.finishTranslation(); await t.close() }
})

test('Native单元引用范围校验拒绝猜测或未提供ID，主Agent纠错不改变其它历史', async () => {
  const t = await fixture(), p = installExecutionProvider(t)
  try {
    await t.materials.send(t.session.id); await t.main.agent.whenIdle()
    await waitFor(() => t.store.getTranslationHistory(t.session.id).units[0]?.revisions[0]?.status === 'completed')
    const target = { kind: 'unit', mainSessionId: mainId, translationSessionId: t.session.id, unitId: 'synthetic-guessed-unit', sourceVersion: 1 }
    const result = await t.f.host.ctx.tools.execute({ agent: t.main.agent, name: 'translation_execute', arguments: { target, operationId: 'guessed-retranslate', organizedRequirements: '', termReferences: [] },
      callId: 'native-guessed-unit', signal: new AbortController().signal })
    assert.equal(result.isError, true)
    const correct = await t.f.host.ctx.tools.execute({ agent: t.main.agent, name: 'translation_correct_source', arguments: { target, operationId: 'guessed-correction', sourceText: 'Synthetic rewrite', reason: '' },
      callId: 'native-guessed-source', signal: new AbortController().signal })
    assert.equal(correct.isError, true); assert.equal(p.translationCalls, 1)
    const unit = t.store.getTranslationHistory(t.session.id).units[0]
    assert.equal(unit.sourceVersion, 1); assert.equal(unit.sourceVersions.length, 1)
  } finally { await t.close() }
})
