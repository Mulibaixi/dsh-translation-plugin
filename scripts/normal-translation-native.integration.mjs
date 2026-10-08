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
async function fixture() {
  const f = await createTopicToolsNativeFixture({ runtimeRoot })
  const main = await f.createAgent(mainId), store = new SessionStore(), session = store.createSession(mainId)
  store.updateSession(session.id, { mode: 'normal', input: 'Synthetic source A', model: { provider: 'synthetic', model: 'model-a' } })
  const terms = new TopicMemoryStore(store), archive = new TopicArchiveStore(store, (sessionId, unitId) => terms.readEvidence(sessionId, unitId))
  const bridge = f.bridge(store, terms, archive), release = bridge.retain(mainId)
  const materials = new MaterialSubmissionsClient({ store, topics: bridge, remote: f.client.remote.translationMaterials,
    owner: {}, registry: { register: () => () => {} } })
  const normal = new NormalTranslationClient(store, materials, terms, ownerId => bridge.retain(ownerId))
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
  return { f, main, store, session, materials, bridge, normal, send, executeRequest,
    async close() { normal.dispose(); materials.dispose(); release(); await main.dispose(); archive.dispose(); terms.dispose(); store.dispose(); await f.close() } }
}

test('Native 2A公开执行工具真实注册并明确unavailable，主Agent正常讨论不消费材料或建立单元', async () => {
  const t = await fixture()
  try {
    const envelope = await t.send(), request = t.executeRequest(envelope), calls = t.f.host.provider.calls.length
    const result = await t.f.host.ctx.tools.execute({ agent: t.main.agent, name: 'translation_execute', arguments: request,
      callId: 'native-normal-gated-call', signal: new AbortController().signal })
    assert.equal(result.isError, true); assert.ok(JSON.stringify(result).includes('尚未接入'))
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
