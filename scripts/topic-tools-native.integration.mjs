import assert from 'node:assert/strict'
import test from 'node:test'
import { createTopicToolsNativeFixture, waitTopicReady } from '../tests/topic-tools-native-fixture.mjs'
import { SessionStore } from '../dist/client/session-store.js'
import { DEFAULT_SESSION_SETTINGS, SETTINGS_KEY } from '../dist/client/sessions.js'
import { TopicMemoryStore } from '../dist/client/topic-memory-store.js'
import { appendTextUnit, selectFinalRevision } from '../dist/client/translation-history.js'

const runtimeRoot = process.env.DSH_RUNTIME_ROOT
if (!runtimeRoot) throw new Error('DSH_RUNTIME_ROOT is required with the installed Agent/Tools/SessionController and Gateway components')
const at = '2026-10-06T00:00:00.000Z', mainId = 'synthetic-topic-main', otherId = 'synthetic-topic-neighbor'
const toolNames = ['translation_list_sessions', 'translation_list_topics', 'translation_create_session', 'translation_rename_topic', 'translation_set_session_remark',
  'translation_archive_session', 'translation_read_unit', 'translation_list_terms', 'translation_query_terms', 'translation_upsert_term']
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

test('Native Agent/Tools + ClientRemoteService/Gateway：十工具真实注册、metadata双向回执与邻Agent隔离，断开卸载', async () => {
  const f = await createTopicToolsNativeFixture({ runtimeRoot }), b = browser()
  let main, neighbor, release
  try {
    main = await f.createAgent(mainId); neighbor = await f.createAgent(otherId)
    assert.equal((await f.client.remote.translationQuick.capabilities()).value.ok, true, 'combined mount retains the Quick namespace')
    assert.equal((await f.client.remote.translationQuick.open({ localSessionId: 'synthetic-coexisting-quick', maxSourceCodePoints: 100 })).value.ok, true)
    const bridge = f.bridge(b.sessions, b.terms); release = bridge.retain(mainId); await waitTopicReady(bridge, mainId, f.carrierErrors)
    const schema = f.host.ctx.tools.schemas(main.agent).filter(item => item.name.startsWith('translation_'))
    assert.deepEqual(new Set(schema.map(item => item.name)), new Set(toolNames))
    assert.equal(f.host.ctx.tools.schemas(neighbor.agent).filter(item => item.name.startsWith('translation_')).length, 0)
    assert.equal(f.host.ctx.tools.schemas().filter(item => item.name.startsWith('translation_')).length, 0)
    const result = await execute(f, main.agent, 'translation_list_sessions', {}, 'actual-native-call')
    assert.equal(result.isError, false); assert.equal(result.value.sessions.length, 1); assert.equal(result.value.sessions[0].id, b.session.id)
    assert.equal(result.value.sessions[0].mode, 'quick'); assert.ok(!JSON.stringify(result.value).includes('input'))
    assert.equal(result.value.sessions[0].sequence, 0); assert.equal(result.value.sessions[0].topicName, b.session.topicName)
    assert.equal(result.value.sessions[0].remark, ''); assert.equal(result.value.sessions[0].archived, false); assert.equal(result.value.persistence, undefined)
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
    assert.equal(f.host.ctx.tools.schemas(main.agent).filter(item => item.name.startsWith('translation_')).length, 10)
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

test('Native PTC呈现：真实perAgent SDK含十工具，主模型仅见run_code入口，邻Agent不包含管理SDK', async () => {
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
    for (const name of toolNames) assert.ok(sdk.includes(name))
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

test('Native管理工具：三创建分支、CAS与runtime_only回执真实过桥，不抢前台或调用provider', async () => {
  const f = await createTopicToolsNativeFixture({ runtimeRoot }), b = browser()
  let main, release
  try {
    main = await f.createAgent(mainId)
    b.sessions.updateSession(b.session.id, { mode: 'normal', input: 'Private managed-session draft', instruction: 'Private translation requirements' })
    const active = b.sessions.getActiveSession(mainId).id, bridge = f.bridge(b.sessions, b.terms)
    release = bridge.retain(mainId); await waitTopicReady(bridge, mainId, f.carrierErrors)
    const topics = await execute(f, main.agent, 'translation_list_topics')
    assert.equal(topics.isError, false); assert.deepEqual(topics.value.topics[0].sessionIds, [b.session.id])
    const requestsBeforeInvalid = f.requests.length
    assert.equal((await execute(f, main.agent, 'translation_create_session', { start: { kind: 'new_topic' }, reason: '' })).isError, true)
    assert.equal(f.requests.length, requestsBeforeInvalid); assert.equal(bridge.getStatus(mainId).ready, true)
    const childArgs = { start: { kind: 'parent_session', translationSessionId: b.session.id }, reason: 'Continue the explicitly assigned same-topic task' }
    const child = await execute(f, main.agent, 'translation_create_session', childArgs)
    assert.equal(child.isError, false); assert.equal(child.value.reason, childArgs.reason); assert.equal(child.value.persistence, 'runtime_only')
    assert.equal(child.value.session.topicId, b.session.topicId); assert.equal(child.value.session.sequence, 1); assert.equal(child.value.session.mode, 'normal')
    assert.equal(child.value.session.remark, ''); assert.equal(b.sessions.getSession(child.value.session.id).input, '')
    assert.equal(b.sessions.getActiveSession(mainId).id, active)
    const reused = await execute(f, main.agent, 'translation_create_session', { start: { kind: 'existing_topic', topicId: b.session.topicId }, reason: 'Reuse the same assigned topic' })
    assert.equal(reused.isError, false); assert.equal(reused.value.session.sequence, 2); assert.equal(reused.value.session.topicId, b.session.topicId)
    const fresh = await execute(f, main.agent, 'translation_create_session', { start: { kind: 'new_topic' }, reason: 'User explicitly requested a separate synthetic topic' })
    assert.equal(fresh.isError, false); assert.notEqual(fresh.value.session.topicId, b.session.topicId); assert.equal(fresh.value.session.mode, 'quick')
    assert.equal(b.sessions.getActiveSession(mainId).id, active)
    const childId = child.value.session.id
    const renamed = await execute(f, main.agent, 'translation_rename_topic', { topicId: b.session.topicId, expectedName: b.session.topicName, name: 'Synthetic renamed topic' })
    assert.equal(renamed.isError, false); assert.equal(renamed.value.persistence, 'runtime_only')
    assert.ok(renamed.value.sessions.every(item => item.topicName === 'Synthetic renamed topic'))
    assert.equal((await execute(f, main.agent, 'translation_rename_topic', { topicId: b.session.topicId, expectedName: b.session.topicName, name: 'Stale rename' })).isError, true)
    const remark = await execute(f, main.agent, 'translation_set_session_remark', { translationSessionId: childId, expectedRemark: '', remark: 'Independent synthetic remark' })
    assert.equal(remark.isError, false); assert.equal(remark.value.sessions[0].remark, 'Independent synthetic remark')
    assert.equal(b.sessions.getSession(childId).instruction, 'Private translation requirements')
    assert.equal((await execute(f, main.agent, 'translation_set_session_remark', { translationSessionId: childId, expectedRemark: '', remark: 'Stale overwrite' })).isError, true)
    for (const [expectedArchived, archived] of [[false, true], [true, false]]) {
      const result = await execute(f, main.agent, 'translation_archive_session', { translationSessionId: childId, expectedArchived, archived })
      assert.equal(result.isError, false); assert.equal(result.value.sessions[0].archived, archived); assert.equal(result.value.persistence, 'runtime_only')
      assert.equal(b.sessions.getActiveSession(mainId).id, active)
    }
    assert.equal((await execute(f, main.agent, 'translation_archive_session', { translationSessionId: childId, expectedArchived: true, archived: false })).isError, true)
    assert.equal((await execute(f, main.agent, 'translation_list_terms', { topicId: b.session.topicId })).isError, false)
    assert.equal((await execute(f, main.agent, 'translation_list_terms', { topicId: b.session.topicId, translationSessionId: childId })).isError, true)
    assert.equal((await execute(f, main.agent, 'translation_list_terms', {})).isError, true)
    const outside = b.sessions.createSession(otherId)
    assert.equal((await execute(f, main.agent, 'translation_create_session', { start: { kind: 'parent_session', translationSessionId: outside.id }, reason: 'Unowned target' })).isError, true)
    assert.equal((await execute(f, main.agent, 'translation_create_session', { start: { kind: 'existing_topic', topicId: outside.topicId }, reason: 'Unowned target' })).isError, true)
    assert.equal((await execute(f, main.agent, 'translation_list_terms', { topicId: outside.topicId })).isError, true)
    assert.equal(f.host.provider.calls.length, 0)
    const receipts = JSON.stringify(f.replies)
    assert.ok(!receipts.includes('Private managed-session draft')); assert.ok(!receipts.includes('Private translation requirements'))
  } finally { release?.(); await main?.dispose(); await f.close(); b.close() }
})

test('Native主模型真实create_session tool-call：准确start/reason与实际summary回填主Agent，不自动设置remark或焦点', async () => {
  const f = await createTopicToolsNativeFixture({ runtimeRoot }), b = browser()
  let main, release
  try {
    main = await f.createAgent(mainId)
    const bridge = f.bridge(b.sessions, b.terms); release = bridge.retain(mainId); await waitTopicReady(bridge, mainId, f.carrierErrors)
    const active = b.sessions.getActiveSession(mainId).id
    const args = { start: { kind: 'parent_session', translationSessionId: b.session.id }, reason: 'Continue the user-assigned synthetic same-topic task' }
    let calls = 0
    f.host.provider.stream = async function* (options) {
      this.calls.push(options); calls++
      if (calls === 1) {
        const call = { type: 'tool-call', id: 'synthetic-create-call', name: 'translation_create_session', arguments: JSON.stringify(args) }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments }
        yield { type: 'block-end', index: 0, block: call }
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: 'Synthetic background Session created' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Synthetic background Session created' } }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    main.agent.followup({ content: [{ type: 'text', text: 'Synthetic scoped background Session task' }], source: { kind: 'user' } })
    await main.agent.whenIdle()
    assert.equal(calls, 2, 'only the two synthetic main-model turns; no translation dispatch')
    const request = f.requests.find(item => item.callId === 'synthetic-create-call')
    assert.deepEqual(request.command, { kind: 'create_session', ...args })
    const reply = f.replies.find(item => item.requestId === request.requestId)
    assert.equal(reply.ok, true); assert.equal(reply.value.reason, args.reason); assert.equal(reply.value.persistence, 'runtime_only')
    assert.equal(reply.value.session.topicId, b.session.topicId); assert.equal(reply.value.session.remark, '')
    assert.equal(b.sessions.getActiveSession(mainId).id, active)
    assert.ok(JSON.stringify(f.host.provider.calls[1].messages).includes(reply.value.session.id))
    assert.ok(main.agent.session.snapshotEvents().some(event => event.type === 'tool/result'))
  } finally { release?.(); await main?.dispose(); await f.close(); b.close() }
})

test('Native管理保存回执：saved须实际落盘，保存失败返回error且允许查询实际内存状态', async () => {
  const values = new Map([[SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SESSION_SETTINGS, rememberHistory: true })]])
  let failWrite = false
  const storage = { get length() { return values.size }, key: index => [...values.keys()][index] ?? null, getItem: key => values.get(key) ?? null,
    setItem(key, value) { if (failWrite) throw new Error('synthetic quota'); values.set(key, value) }, removeItem: key => values.delete(key) }
  const locks = { request: async (_name, action) => await action() }
  const sessions = new SessionStore(storage, undefined, locks), terms = new TopicMemoryStore(sessions, storage, undefined, locks)
  const f = await createTopicToolsNativeFixture({ runtimeRoot })
  let main, release
  try {
    const parent = await sessions.createSessionAsync(mainId)
    main = await f.createAgent(mainId)
    const bridge = f.bridge(sessions, terms); release = bridge.retain(mainId); await waitTopicReady(bridge, mainId, f.carrierErrors)
    const created = await execute(f, main.agent, 'translation_create_session', { start: { kind: 'parent_session', translationSessionId: parent.id }, reason: 'Synthetic persisted same-topic task' })
    assert.equal(created.isError, false); assert.equal(created.value.persistence, 'saved')
    const id = created.value.session.id
    assert.equal(sessions.getStatus(id), 'saved'); assert.ok([...values.values()].some(raw => raw.includes(id)))
    const updated = await execute(f, main.agent, 'translation_set_session_remark', { translationSessionId: id, expectedRemark: '', remark: 'Synthetic saved remark' })
    assert.equal(updated.isError, false); assert.equal(updated.value.persistence, 'saved')
    assert.ok([...values.values()].some(raw => raw.includes('Synthetic saved remark')))
    failWrite = true
    const failed = await execute(f, main.agent, 'translation_set_session_remark', { translationSessionId: id, expectedRemark: 'Synthetic saved remark', remark: 'Synthetic unsaved remark' })
    assert.equal(failed.isError, true); assert.ok(!JSON.stringify(failed).includes('"persistence":"saved"'))
    failWrite = false
    const listed = await execute(f, main.agent, 'translation_list_sessions')
    assert.equal(listed.isError, false); assert.equal(listed.value.sessions.find(item => item.id === id).remark, sessions.getSession(id).remark)
    assert.ok(![...values.values()].some(raw => raw.includes('Synthetic unsaved remark')))
    assert.equal(f.host.provider.calls.length, 0)
  } finally { failWrite = false; release?.(); await main?.dispose(); await f.close(); terms.dispose(); sessions.dispose() }
})
