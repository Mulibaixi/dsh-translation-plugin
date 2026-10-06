import assert from 'node:assert/strict'
import test from 'node:test'
import { createTopicToolsNativeFixture, waitTopicReady } from '../tests/topic-tools-native-fixture.mjs'
import { SessionStore } from '../dist/client/session-store.js'
import { TopicMemoryStore } from '../dist/client/topic-memory-store.js'
import { appendTextUnit, selectFinalRevision } from '../dist/client/translation-history.js'

const runtimeRoot = process.env.DSH_RUNTIME_ROOT
if (!runtimeRoot) throw new Error('DSH_RUNTIME_ROOT is required with the installed Agent/Tools/SessionController and Gateway components')
const at = '2026-10-06T00:00:00.000Z', mainId = 'synthetic-topic-main', otherId = 'synthetic-topic-neighbor'
function browser(ownerId = mainId) {
  const sessions = new SessionStore(), session = sessions.createSession(ownerId)
  const terms = new TopicMemoryStore(sessions)
  return { sessions, session, terms, close() { terms.dispose(); sessions.dispose() } }
}
async function execute(f, agent, name, args = {}, callId = `synthetic-${name}`) {
  return f.host.ctx.tools.execute({ agent, name, arguments: args, callId, signal: new AbortController().signal })
}
function history(sessions, id) {
  sessions.updateTranslationHistory(id, value => selectFinalRevision(appendTextUnit(value, {
    id: 'synthetic-unit', source: 'Synthetic API source', targetLanguage: '中文', instruction: '', createdAt: at,
  }, { id: 'synthetic-revision', operationId: 'synthetic-operation', kind: 'machine', baseRevisionId: null, callRecord: null,
    model: { provider: 'synthetic', model: 'model-a' }, draftVersion: 1, createdAt: at, updatedAt: at,
    accepted: true, status: 'completed', text: '合成 API 译文', message: null }), 'synthetic-unit', 'synthetic-revision', at))
}
function put(sessionId, edits = {}) {
  return { translationSessionId: sessionId, expectedVersion: 0, entry: { id: 'synthetic-term', expectedEntryVersion: null,
    sourceLanguage: 'English', targetLanguage: '中文', sourceForms: ['API'], aliases: ['interface'], sense: 'Synthetic interface', preferred: '接口', forbidden: [],
    origin: 'inferred', status: 'proposal', evidence: [], ...edits } }
}

test('Native Agent/Tools + ClientRemoteService/Gateway：五工具真实注册、metadata双向回执与邻Agent隔离，断开卸载', async () => {
  const f = await createTopicToolsNativeFixture({ runtimeRoot }), b = browser()
  let main, neighbor, release
  try {
    main = await f.createAgent(mainId); neighbor = await f.createAgent(otherId)
    assert.equal((await f.client.remote.translationQuick.capabilities()).value.ok, true, 'combined mount retains the Quick namespace')
    assert.equal((await f.client.remote.translationQuick.open({ localSessionId: 'synthetic-coexisting-quick', maxSourceCodePoints: 100 })).value.ok, true)
    const bridge = f.bridge(b.sessions, b.terms); release = bridge.retain(mainId); await waitTopicReady(bridge, mainId, f.carrierErrors)
    const schema = f.host.ctx.tools.schemas(main.agent).filter(item => item.name.startsWith('translation_'))
    assert.equal(schema.length, 5); assert.ok(schema.some(item => item.name === 'translation_query_terms'))
    assert.equal(f.host.ctx.tools.schemas(neighbor.agent).filter(item => item.name.startsWith('translation_')).length, 0)
    assert.equal(f.host.ctx.tools.schemas().filter(item => item.name.startsWith('translation_')).length, 0)
    const result = await execute(f, main.agent, 'translation_list_sessions', {}, 'actual-native-call')
    assert.equal(result.isError, false); assert.equal(result.value.sessions.length, 1); assert.equal(result.value.sessions[0].id, b.session.id)
    assert.equal(result.value.sessions[0].mode, 'quick'); assert.ok(!JSON.stringify(result.value).includes('input'))
    assert.equal(f.requests[0].callId, 'actual-native-call'); assert.equal(f.requests[0].mainSessionId, mainId)
    const denied = await execute(f, neighbor.agent, 'translation_list_sessions')
    assert.equal(denied.isError, true); assert.equal(f.requests.length, 1)
    const proposal = await execute(f, main.agent, 'translation_upsert_term', put(b.session.id))
    assert.equal(proposal.isError, false); assert.equal(proposal.value.snapshot.entries[0].status, 'proposal')
    const stale = await execute(f, main.agent, 'translation_upsert_term', put(b.session.id, { preferred: '接口二' }))
    assert.equal(stale.isError, true); assert.equal(b.terms.getSnapshot(mainId, b.session.topicId).entries[0].preferred, '接口')
    const quickQuery = await execute(f, main.agent, 'translation_query_terms', { translationSessionId: b.session.id, sourceLanguage: 'English', targetLanguage: '中文', forms: ['API'] })
    assert.equal(quickQuery.isError, false); assert.deepEqual(quickQuery.value.snapshot.entries, [])
    assert.equal(f.host.provider.calls.length, 0, 'management alone never dispatches the translation provider')
    release(); release = undefined
    for (let i = 0; i < 100 && f.host.ctx.tools.schemas(main.agent).some(item => item.name.startsWith('translation_')); i++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(f.host.ctx.tools.schemas(main.agent).filter(item => item.name.startsWith('translation_')).length, 0)
    assert.equal((await execute(f, main.agent, 'translation_list_sessions')).isError, true)
  } finally { release?.(); await main?.dispose(); await neighbor?.dispose(); await f.close(); b.close() }
})

test('Native主模型真实tool-call→Client权威：历史需显式公开，active依据/精确query可核验，用户采用不可被模型覆盖', async () => {
  const f = await createTopicToolsNativeFixture({ runtimeRoot }), b = browser()
  let main, release
  try {
    main = await f.createAgent(mainId); history(b.sessions, b.session.id); b.sessions.updateSession(b.session.id, { mode: 'normal', input: 'Unpublished current draft' })
    const bridge = f.bridge(b.sessions, b.terms); release = bridge.retain(mainId); await waitTopicReady(bridge, mainId, f.carrierErrors)
    const undisclosed = await execute(f, main.agent, 'translation_read_unit', { translationSessionId: b.session.id, unitId: 'synthetic-unit' })
    assert.equal(undisclosed.isError, true)
    assert.equal(bridge.publishUnit(mainId, b.session.id, 'synthetic-unit'), true)
    const source = { kind: 'source', sessionId: b.session.id, unitId: 'synthetic-unit', revisionId: null, selectionEventId: null, range: null, role: 'basis' }
    const checked = put(b.session.id, { origin: 'source_checked', status: 'active', evidence: [source] })
    const active = await execute(f, main.agent, 'translation_upsert_term', checked)
    assert.equal(active.isError, false); assert.equal(active.value.snapshot.entries[0].status, 'active')
    const unit = await execute(f, main.agent, 'translation_read_unit', { translationSessionId: b.session.id, unitId: 'synthetic-unit' })
    assert.equal(unit.isError, false); assert.ok(unit.value.unit.final.selectionEventId); assert.ok(!JSON.stringify(unit).includes('Unpublished current draft'))
    const selected = await execute(f, main.agent, 'translation_query_terms', { translationSessionId: b.session.id, sourceLanguage: 'English', targetLanguage: '中文', forms: ['interface'] })
    assert.equal(selected.isError, false); assert.equal(selected.value.snapshot.entries[0].preferred, '接口')
    const mismatched = await execute(f, main.agent, 'translation_query_terms', { translationSessionId: b.session.id, sourceLanguage: 'English', targetLanguage: '中文', forms: ['APIx'] })
    assert.deepEqual(mismatched.value.snapshot.entries, [])
    const adopted = await b.terms.apply(mainId, b.session.topicId, selected.value.snapshot.version, { kind: 'adopt', id: 'synthetic-term', expectedEntryVersion: selected.value.snapshot.entries[0].version })
    assert.equal(adopted.status, 'updated')
    const rewrite = await execute(f, main.agent, 'translation_upsert_term', { ...checked, expectedVersion: adopted.snapshot.version, entry: { ...checked.entry, expectedEntryVersion: adopted.entry.version, preferred: '模型覆盖' } })
    assert.equal(rewrite.isError, true); assert.equal(b.terms.getSnapshot(mainId, b.session.topicId).entries[0].preferred, '接口')

    // Synthetic model emits an ordinary native tool call; actual AgentLoop logs and dispatches it.
    let calls = 0
    f.host.provider.stream = async function* (options) {
      this.calls.push(options); calls++
      if (calls === 1) {
        const call = { type: 'tool-call', id: 'synthetic-model-call', name: 'translation_query_terms', arguments: JSON.stringify({ translationSessionId: b.session.id, sourceLanguage: 'English', targetLanguage: '中文', forms: ['API'] }) }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments }
        yield { type: 'block-end', index: 0, block: call }
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: 'Synthetic management complete' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Synthetic management complete' } }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    main.agent.followup({ content: [{ type: 'text', text: 'Synthetic terminology query' }], source: { kind: 'user' } })
    await main.agent.whenIdle()
    assert.equal(calls, 2)
    assert.ok(f.requests.some(request => request.callId === 'synthetic-model-call' && request.command.kind === 'query_terms'))
    assert.ok(JSON.stringify(f.host.provider.calls[1].messages).includes('接口'))
    assert.ok(!JSON.stringify(f.host.provider.calls).includes('Unpublished current draft'))
    assert.ok(main.agent.session.snapshotEvents().some(event => event.type === 'tool/result'))
    assert.ok(!f.requests.some(request => request.command.kind === 'read_material'))
  } finally { release?.(); await main?.dispose(); await f.close(); b.close() }
})

test('Native Session metadata可在Agent存在前绑定，created补装；同主第二连接不抢占且显式重连可恢复', async () => {
  const f = await createTopicToolsNativeFixture({ runtimeRoot }), b = browser()
  let main, release
  const session = f.host.ctx.sessions.prepare(mainId), detach = f.host.ctx.sessions.enter(session)
  f.host.ctx.sessions.announce(session)
  try {
    const bridge = f.bridge(b.sessions, b.terms); release = bridge.retain(mainId); await waitTopicReady(bridge, mainId, f.carrierErrors)
    assert.equal(f.host.ctx.agents.get(mainId), undefined); assert.equal(f.host.provider.calls.length, 0)
    const duplicate = f.remote.connect({ ownerId: mainId, mainSessionId: mainId })
    await assert.rejects(duplicate[Symbol.asyncIterator]().next(), /占用/)
    duplicate.dispose(); detach()
    main = await f.createAgent(mainId)
    assert.equal(f.host.ctx.tools.schemas(main.agent).filter(item => item.name.startsWith('translation_')).length, 5)
    assert.equal((await execute(f, main.agent, 'translation_list_sessions')).isError, false)
    release(); release = undefined
    for (let i = 0; i < 100 && f.host.ctx.tools.schemas(main.agent).some(item => item.name.startsWith('translation_')); i++) await new Promise(resolve => setTimeout(resolve, 5))
    release = bridge.retain(mainId); await waitTopicReady(bridge, mainId, f.carrierErrors)
    assert.equal((await execute(f, main.agent, 'translation_list_terms', { translationSessionId: b.session.id })).isError, false)
  } finally { release?.(); detach(); await main?.dispose(); await f.close(); b.close() }
})

test('Native Gateway strict uplink拒绝任意配置，未确认写结束unknown并卸载，绝不隐式重发', async () => {
  const f = await createTopicToolsNativeFixture({ runtimeRoot })
  let main, handle
  try {
    main = await f.createAgent(mainId)
    handle = f.remote.connect({ ownerId: mainId, mainSessionId: mainId })
    const iterator = handle[Symbol.asyncIterator]()
    assert.equal((await iterator.next()).value.kind, 'ready')
    const pending = execute(f, main.agent, 'translation_upsert_term', put('synthetic-translation'), 'synthetic-uncertain-write')
    const request = (await iterator.next()).value
    assert.equal(request.command.kind, 'upsert_term'); assert.equal(request.callId, 'synthetic-uncertain-write')
    handle.send({ requestId: request.requestId, ok: true, value: { kind: 'sessions', sessions: [], providerConfiguration: { token: 'synthetic-forbidden-field' } } })
    await assert.rejects(iterator.next())
    const result = await pending
    assert.equal(result.isError, true)
    assert.equal(f.requests.length, 1); assert.equal(f.replies.length, 1)
    assert.equal(f.host.ctx.tools.schemas(main.agent).filter(item => item.name.startsWith('translation_')).length, 0)
    assert.equal(f.host.provider.calls.length, 0)
  } finally { handle?.dispose(); await main?.dispose(); await f.close() }
})

test('Native PTC呈现：真实perAgent SDK含五工具，主模型仅见run_code入口，邻Agent不包含术语SDK', async () => {
  const f = await createTopicToolsNativeFixture({ runtimeRoot }), b = browser()
  let main, neighbor, release, presentation
  try {
    main = await f.createAgent(mainId); neighbor = await f.createAgent(otherId)
    const bridge = f.bridge(b.sessions, b.terms); release = bridge.retain(mainId); await waitTopicReady(bridge, mainId, f.carrierErrors)
    // Presentation-only metadata. No pretend code execution or substitute PTC backend is used.
    f.host.ctx.provide('ptcRuntime', { language: 'typescript' })
    presentation = main.agent.ctx.tools.presentAs('ptc')
    const { renderToolsSdk } = await f.host.native('@deepseek-ai/dsh-tools')
    const sdk = renderToolsSdk(f.host.ctx.tools.sdkSchemas(main.agent))
    for (const name of ['translation_list_sessions', 'translation_read_unit', 'translation_list_terms', 'translation_query_terms', 'translation_upsert_term']) assert.ok(sdk.includes(name))
    assert.ok(!renderToolsSdk(f.host.ctx.tools.sdkSchemas(neighbor.agent)).includes('translation_'))
    assert.deepEqual(f.host.ctx.tools.wireSchemas(main.agent).schemas.map(item => item.name), ['run_code'])
    assert.equal((await execute(f, main.agent, 'translation_list_sessions')).isError, true, 'PTC intentionally disallows a model-direct collapsed tool call')
    assert.equal(f.requests.length, 0); assert.equal(f.host.provider.calls.length, 0)
    const assembly = await f.host.ctx.systemPrompt.assemble({ scope: main.agent, agent: main.agent })
    assert.ok(JSON.stringify(assembly).includes('translation_query_terms'))
    presentation(); presentation = undefined
    assert.equal((await execute(f, main.agent, 'translation_list_sessions')).isError, false)
  } finally { presentation?.(); release?.(); await main?.dispose(); await neighbor?.dispose(); await f.close(); b.close() }
})
