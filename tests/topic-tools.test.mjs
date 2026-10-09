import assert from 'node:assert/strict'
import test from 'node:test'
import { TopicToolsService } from '../dist/host/topic-tools.js'
import { parseTopicBridgeOpen, parseTopicBridgeCommand, parseTopicBridgeDown, parseTopicBridgeReply, MAX_TOPIC_BRIDGE_REPLY_BYTES, TOPIC_BRIDGE_REMOTE } from '../dist/shared/topic-bridge.js'
import { emptyTopicTerms } from '../dist/memory/topic-terms.js'
import { emptyTopicArchive } from '../dist/memory/topic-archive.js'
import { PLUGIN_REMOTE } from '../dist/shared/plugin-remote.js'

function queue() {
  const items = []; let wake; let closed = false
  return { push(value) { items.push(value); wake?.(); wake = undefined },
    [Symbol.asyncIterator]() { return this },
    async next() { if (!items.length && !closed) await new Promise(resolve => { wake = resolve }); return items.length ? { value: items.shift(), done: false } : { done: true } },
    async return() { closed = true; wake?.(); return { done: true } },
  }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const open = { ownerId: 'synthetic-main', mainSessionId: 'synthetic-main' }
function fixture({ initialAgent = true, timeout = 1000, materials } = {}) {
  const inbox = queue(), listeners = new Map(), tools = new Map(), calls = []
  const agent = { id: open.mainSessionId, session: { id: open.mainSessionId }, ctx: { tools: {
    register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) },
  } } }
  const ctx = { invocation: { peer: { id: 'synthetic-peer' }, uplink: () => inbox },
    get(key) { return { agents: { get: () => initialAgent ? agent : undefined }, tools: {}, translationMaterials: materials, sessionController: {
      async list(request, signal) { calls.push(request); signal.throwIfAborted(); return { items: [{ sessionId: open.mainSessionId }] } },
    } }[key] },
    on(event, listener) { listeners.set(event, listener); return () => listeners.delete(event) },
  }
  const service = new TopicToolsService(ctx, async () => ({ defineTool: options => options }), timeout)
  const controller = new AbortController(), stream = service.connect(open, controller.signal)
  return { service, stream, controller, inbox, tools, calls, listeners, agent,
    exec: { agent, callId: 'actual-call-id', signal: new AbortController().signal },
    async close() { controller.abort(); await stream.return(); service.dispose() },
  }
}
const sessionsReply = id => ({ requestId: id, ok: true, value: { kind: 'sessions', sessions: [] } })
const summary = { id: 's', topicId: 't', name: 'Synthetic 1', mode: 'quick', publishedUnitIds: [], topicName: 'Synthetic', sequence: 1, remark: '', archived: false }

test('原文读取注册沿用连接生命周期，实际Agent/中断检查在读取前完成，不发桥接业务请求', async () => {
  const reads = [], args = { target: { kind: 'material', mainSessionId: open.mainSessionId, requestId: 'r', materialId: 'm', sourceVersion: 1 }, range: { start: 0, end: 1 } }
  const released = []
  const f = fixture({ materials: {
    readSource(request, agent) { reads.push({ request, agent }); return { ok: true, value: { ...request, totalCodePoints: 1, text: '😀' } } },
    releaseConnection(ownerId, peerId) { released.push({ ownerId, peerId }) },
  } })
  let tool
  try {
    await f.stream.next(); assert.equal(f.tools.size, 14)
    f.listeners.get('agent/created')({ agent: f.agent }); assert.equal(f.tools.size, 14)
    tool = f.tools.get('translation_read_source')
    assert.equal(tool.parameters.target.additionalProperties, false); assert.equal(tool.parameters.range.additionalProperties, false)
    const page = tool.execute(args, f.exec)
    assert.equal(page.text, '😀'); assert.equal(reads.length, 1); assert.equal(reads[0].agent, f.agent)
    assert.deepEqual(tool.output.render(args, page), [{ type: 'text', text: JSON.stringify(page) }])
    assert.throws(() => tool.execute(args, { ...f.exec, agent: { ...f.agent } }), { code: 'scope_mismatch' })
    const aborted = new AbortController(); aborted.abort()
    assert.throws(() => tool.execute(args, { ...f.exec, signal: aborted.signal }), { name: 'AbortError' })
    assert.equal(reads.length, 1)
  } finally { await f.close() }
  assert.equal(f.tools.size, 0)
  assert.deepEqual(released, [{ ownerId: open.ownerId, peerId: 'synthetic-peer' }])
  assert.throws(() => tool.execute(args, f.exec), { code: 'scope_mismatch' })
  assert.equal(reads.length, 1)
})

test('topic bridge仅公开管理/历史协议，严格拒绝凭据、伪造owner和普通材料命令', () => {
  assert.deepEqual(parseTopicBridgeOpen(open), open)
  for (const value of [{ ...open, ownerId: 'other' }, { ...open, profile: {} }]) assert.throws(() => parseTopicBridgeOpen(value))
  assert.throws(() => parseTopicBridgeCommand({ kind: 'read_material', translationSessionId: 's', materialId: 'm' }))
  assert.throws(() => parseTopicBridgeCommand({ kind: 'list_terms', translationSessionId: 's', mainSessionId: 'spoof' }))
  assert.throws(() => parseTopicBridgeReply({ ...sessionsReply('r'), config: { token: 'synthetic-secret' } }))
  assert.throws(() => parseTopicBridgeReply({ requestId: 'r', ok: true, value: { kind: 'sessions', sessions: [{ id: 's', topicId: 't', name: 'Synthetic', mode: 'quick', publishedUnitIds: [], profile: {} }] } }))
  const descriptor = TOPIC_BRIDGE_REMOTE.descriptors.find(item => item.method === 'connect')
  assert.equal(descriptor.mode, 'stream'); assert.equal(descriptor.uplink.codec.mode, 'strict')
  assert.equal(PLUGIN_REMOTE.package, TOPIC_BRIDGE_REMOTE.package)
  assert.equal(PLUGIN_REMOTE.descriptors.length, 23)
  assert.deepEqual(new Set(PLUGIN_REMOTE.descriptors.map(item => item.namespace)), new Set(['translationQuick', 'translationTopics', 'translationObjects', 'translationMaterials', 'translationNormal', 'translationSources']))
})

test('topic uplink预算拒绝超额，term query子集不会夹带非active条目', () => {
  const huge = { requestId: 'r', ok: true, value: { kind: 'unit', unit: { id: 'u', order: 1, source: '源'.repeat(MAX_TOPIC_BRIDGE_REPLY_BYTES), targetLanguage: '中文', instruction: '', revisions: [], final: null } } }
  assert.throws(() => parseTopicBridgeReply(huge), /budget/)
  const snapshot = emptyTopicTerms(open.ownerId, 'topic', '2026-10-06T00:00:00.000Z')
  assert.deepEqual(parseTopicBridgeReply({ requestId: 'r', ok: true, value: { kind: 'terms_query', snapshot } }).value.snapshot, snapshot)
  assert.throws(() => parseTopicBridgeDown({ kind: 'request', requestId: 'r', mainSessionId: open.mainSessionId, callId: 'c', command: { kind: 'list_sessions' }, chat: [] }))
})

test('metadata绑定无需先激活Agent，created安装十三工具且同Agent不重复安装', async () => {
  const f = fixture({ initialAgent: false })
  try {
    assert.equal((await f.stream.next()).value.kind, 'ready'); assert.equal(f.tools.size, 0); assert.deepEqual(f.calls, [{}])
    f.listeners.get('agent/created')({ agent: f.agent }); assert.equal(f.tools.size, 13)
    f.listeners.get('agent/created')({ agent: f.agent }); assert.equal(f.tools.size, 13)
    assert.ok(f.tools.has('translation_query_terms')); assert.ok(!f.tools.has('translation_read_material'))
    f.listeners.get('agent/disposed')({ agent: f.agent }); assert.equal(f.tools.size, 0)
  } finally { await f.close() }
  assert.equal(f.listeners.size, 0)
})

test('管理command严格区分三种起点、预期值及Unicode字段，无任意配置或执行入口', () => {
  for (const start of [{ kind: 'new_topic' }, { kind: 'parent_session', translationSessionId: 's' }, { kind: 'existing_topic', topicId: 't' }]) {
    const command = { kind: 'create_session', start, reason: '合成任务范围内创建' }
    assert.deepEqual(parseTopicBridgeCommand(command), command)
  }
  for (const start of [{ kind: 'new_topic', model: {} }, { kind: 'parent_session', topicId: 't' }, { kind: 'existing_topic', translationSessionId: 's' }]) assert.throws(() => parseTopicBridgeCommand({ kind: 'create_session', start, reason: 'reason' }))
  assert.throws(() => parseTopicBridgeCommand({ kind: 'create_session', start: { kind: 'new_topic' }, reason: ' ' }))
  assert.throws(() => parseTopicBridgeCommand({ kind: 'create_session', start: { kind: 'new_topic' }, reason: 'x'.repeat(1001) }))
  for (const command of [
    { kind: 'list_topics' }, { kind: 'list_topic_terms', topicId: 't' },
    { kind: 'rename_topic', topicId: 't', expectedName: 'Synthetic', name: '😀'.repeat(120) },
    { kind: 'set_session_remark', translationSessionId: 's', expectedRemark: '旧备注', remark: '' },
    { kind: 'archive_session', translationSessionId: 's', expectedArchived: false, archived: true },
  ]) assert.deepEqual(parseTopicBridgeCommand(command), command)
  assert.throws(() => parseTopicBridgeCommand({ kind: 'rename_topic', topicId: 't', expectedName: 'Synthetic', name: '😀'.repeat(121) }))
  assert.throws(() => parseTopicBridgeCommand({ kind: 'archive_session', translationSessionId: 's', expectedArchived: false, archived: 'true' }))
  assert.throws(() => parseTopicBridgeCommand({ kind: 'set_session_remark', translationSessionId: 's', expectedRemark: '', remark: '', instruction: 'forbidden' }))
})

test('管理回执仅安全metadata，创建理由与saved/runtime_only明确，orphan topic可空', () => {
  const receipt = value => ({ requestId: 'r', ok: true, value })
  for (const persistence of ['saved', 'runtime_only']) {
    const created = { kind: 'session_created', session: summary, reason: 'Task explanation', persistence }
    assert.deepEqual(parseTopicBridgeReply(receipt(created)).value, created)
    assert.equal(parseTopicBridgeReply(receipt({ kind: 'sessions', sessions: [summary], persistence })).value.persistence, persistence)
  }
  assert.equal(parseTopicBridgeReply(receipt({ kind: 'sessions', sessions: [{ ...summary, sequence: 0 }] })).value.sessions[0].sequence, 0)
  const unicode = { ...summary, name: `${'😀'.repeat(120)} 1`, topicName: '😀'.repeat(120) }
  assert.deepEqual(parseTopicBridgeReply(receipt({ kind: 'sessions', sessions: [unicode] })).value.sessions[0], unicode)
  const topics = { kind: 'topics', topics: [{ id: 't', name: 'Synthetic', nextSequence: 7, sessionIds: [] }] }
  assert.deepEqual(parseTopicBridgeReply(receipt(topics)).value, topics)
  assert.throws(() => parseTopicBridgeReply(receipt({ kind: 'session_created', session: summary, reason: 'Task explanation' })))
  assert.throws(() => parseTopicBridgeReply(receipt({ kind: 'sessions', sessions: [summary], persistence: 'failed' })))
  assert.throws(() => parseTopicBridgeReply(receipt({ kind: 'sessions', sessions: [{ ...summary, input: 'private draft' }] })))
  assert.throws(() => parseTopicBridgeReply(receipt({ ...topics, topics: [{ ...topics.topics[0], ownerId: 'spoof' }] })))
})

test('list_terms工具恰好一项target，topic目标对应orphan命令，管理写带预期值与reason原样传递', async () => {
  const f = fixture()
  try {
    await f.stream.next()
    const list = f.tools.get('translation_list_terms')
    assert.equal(Object.hasOwn(list.parameters.translationSessionId, 'required'), false)
    assert.equal(Object.hasOwn(list.parameters.topicId, 'required'), false)
    assert.throws(() => list.execute({}, f.exec), { code: 'invalid_target' })
    assert.throws(() => list.execute({ translationSessionId: 's', topicId: 't' }, f.exec), { code: 'invalid_target' })
    assert.throws(() => f.tools.get('translation_create_session').execute({ start: { kind: 'new_topic' }, reason: '' }, f.exec), TypeError)
    assert.throws(() => f.tools.get('translation_rename_topic').execute({ topicId: 't', expectedName: 'Synthetic', name: 'x'.repeat(121) }, f.exec), TypeError)
    const cases = [
      ['translation_list_terms', { topicId: 't' }, { kind: 'list_topic_terms', topicId: 't' }, { kind: 'terms', snapshot: emptyTopicTerms(open.ownerId, 't', '2026-10-06T00:00:00.000Z') }],
      ['translation_list_topics', {}, { kind: 'list_topics' }, { kind: 'topics', topics: [] }],
      ['translation_create_session', { start: { kind: 'existing_topic', topicId: 't' }, reason: 'Reuse assigned topic' }, { kind: 'create_session', start: { kind: 'existing_topic', topicId: 't' }, reason: 'Reuse assigned topic' }, { kind: 'session_created', session: summary, reason: 'Reuse assigned topic', persistence: 'runtime_only' }],
      ['translation_rename_topic', { topicId: 't', expectedName: 'Synthetic', name: 'Renamed' }, { kind: 'rename_topic', topicId: 't', expectedName: 'Synthetic', name: 'Renamed' }, { kind: 'sessions', sessions: [], persistence: 'saved' }],
      ['translation_set_session_remark', { translationSessionId: 's', expectedRemark: '', remark: '合成备注' }, { kind: 'set_session_remark', translationSessionId: 's', expectedRemark: '', remark: '合成备注' }, { kind: 'sessions', sessions: [summary], persistence: 'runtime_only' }],
      ['translation_archive_session', { translationSessionId: 's', expectedArchived: false, archived: true }, { kind: 'archive_session', translationSessionId: 's', expectedArchived: false, archived: true }, { kind: 'sessions', sessions: [summary], persistence: 'runtime_only' }],
    ]
    let next = f.stream.next()
    for (const [name, args, command, value] of cases) {
      const result = f.tools.get(name).execute(args, f.exec), frame = (await next).value
      assert.deepEqual(frame.command, command); assert.equal(frame.callId, f.exec.callId)
      f.inbox.push({ requestId: frame.requestId, ok: true, value }); next = f.stream.next()
      assert.deepEqual(await result, value)
    }
    f.controller.abort(); await next
  } finally { await f.close() }
})

test('同main第二管理连接拒绝占用，已abort/额外字段不会建立连接', async () => {
  const f = fixture()
  try {
    await f.stream.next()
    await assert.rejects(f.service.connect(open, new AbortController().signal).next(), { code: 'connection_occupied' })
    const aborted = new AbortController(); aborted.abort()
    await assert.rejects(f.service.connect(open, aborted.signal).next(), { name: 'AbortError' })
    await assert.rejects(f.service.connect({ ...open, profile: {} }, new AbortController().signal).next(), TypeError)
  } finally { await f.close() }
})

test('工具携真实exec Agent/callId双向回执，错误Agent和伪造同id对象拒绝', async () => {
  const f = fixture()
  try {
    await f.stream.next(); const tool = f.tools.get('translation_list_sessions')
    assert.throws(() => tool.execute({}, { ...f.exec, agent: { ...f.agent } }), { code: 'scope_mismatch' })
    const result = tool.execute({}, f.exec), frame = (await f.stream.next()).value
    assert.equal(frame.callId, f.exec.callId); assert.equal(frame.mainSessionId, open.mainSessionId); assert.deepEqual(frame.command, { kind: 'list_sessions' })
    f.inbox.push(sessionsReply(frame.requestId)); const waiting = f.stream.next()
    assert.deepEqual(await result, { kind: 'sessions', sessions: [] })
    f.controller.abort(); await waiting
  } finally { await f.close() }
  assert.equal(f.tools.size, 0)
})

test('Client语义stale返回保留类型，下次显式请求可继续，未重试写', async () => {
  const f = fixture()
  try {
    await f.stream.next(); const tool = f.tools.get('translation_list_terms')
    const result = tool.execute({ translationSessionId: 'translation' }, f.exec)
    const rejected = assert.rejects(result, { code: 'stale' })
    const frame = (await f.stream.next()).value
    f.inbox.push({ requestId: frame.requestId, ok: false, error: { code: 'stale', message: '版本变化' } })
    const waiting = f.stream.next(); await rejected; f.controller.abort(); await waiting
    assert.equal(f.calls.length, 1)
  } finally { await f.close() }
})

test('超时关闭连接并卸载，unknown写不隐式重发', async () => {
  const f = fixture({ timeout: 15 })
  try {
    await f.stream.next()
    const result = f.tools.get('translation_list_sessions').execute({}, f.exec)
    const rejected = assert.rejects(result, { code: 'outcome_unknown' })
    assert.equal((await f.stream.next()).value.kind, 'request')
    await rejected; await tick(); assert.equal(f.tools.size, 0)
    assert.equal((await f.stream.next()).done, true)
  } finally { await f.close() }
})

test('错误correlation不接受结果，pending变unknown并完整cleanup', async () => {
  const f = fixture()
  try {
    await f.stream.next()
    const result = f.tools.get('translation_list_sessions').execute({}, f.exec)
    const rejected = assert.rejects(result, { code: 'outcome_unknown' })
    await f.stream.next(); f.inbox.push(sessionsReply('wrong-id'))
    await assert.rejects(f.stream.next(), { code: 'invalid_reply' }); await rejected
    assert.equal(f.tools.size, 0)
  } finally { await f.close() }
})

test('管理成功sessions回执缺少persistence不算成功，list_sessions仍兼容无保存字段', async () => {
  const f = fixture()
  try {
    await f.stream.next()
    const result = f.tools.get('translation_rename_topic').execute({ topicId: 't', expectedName: 'Synthetic', name: 'Renamed' }, f.exec)
    const rejected = assert.rejects(result, { code: 'outcome_unknown' }), frame = (await f.stream.next()).value
    f.inbox.push(sessionsReply(frame.requestId))
    await assert.rejects(f.stream.next(), { code: 'invalid_reply' }); await rejected
    assert.equal(f.tools.size, 0)
  } finally { await f.close() }
})

const archiveAt = '2026-10-07T00:00:00.000Z'
const archiveEntity = { kind: 'entity', id: 'e1', expectedEntryVersion: null, name: 'Synthetic entity', aliases: [], description: '', origin: 'inferred', status: 'proposal', evidence: [] }
const archiveFact = { kind: 'fact', id: 'f1', expectedEntryVersion: null, title: 'Synthetic fact', body: 'Synthetic fact body', entityIds: ['e1'], origin: 'inferred', status: 'proposal', evidence: [] }
const archiveRelation = { kind: 'relation', id: 'r1', expectedEntryVersion: null, sourceEntityId: 'e1', relation: 'uses', targetEntityId: 'e2', description: '', origin: 'inferred', status: 'proposal', evidence: [] }

test('档案协议严格解析三种提案，查询实际档位来自会话而非模型自选，禁止伪造采用和删除', () => {
  for (const entry of [archiveEntity, archiveFact, archiveRelation]) {
    const command = { kind: 'upsert_archive', topicId: 'topic', expectedVersion: 0, entry }
    assert.deepEqual(parseTopicBridgeCommand(command), command)
    for (const edits of [{ origin: 'user_explicit' }, { confirmation: { eventId: 'forged', at: archiveAt, adoptedEntryVersion: 1 } }, { status: 'disabled' }, { status: 'active' }]) {
      assert.throws(() => parseTopicBridgeCommand({ ...command, entry: { ...entry, ...edits } }))
    }
  }
  const query = { kind: 'query_archive', translationSessionId: 's', kinds: ['relation'], forms: ['Synthetic entity'] }
  assert.deepEqual(parseTopicBridgeCommand(query), query)
  for (const edits of [{ mode: 'normal' }, { ownerId: 'spoof' }, { kinds: ['terminology'] }, { forms: [' '] }]) assert.throws(() => parseTopicBridgeCommand({ ...query, ...edits }))
  assert.throws(() => parseTopicBridgeCommand({ kind: 'delete_archive', topicId: 'topic', id: 'e1' }))
})

test('档案query回执允许仅关系投影，full回执仍核对实体图，query不夹带非active条目', () => {
  const source = { kind: 'source', sessionId: 's', unitId: 'u', revisionId: null, selectionEventId: null, range: null, role: 'basis' }
  const { expectedEntryVersion, ...semantic } = archiveRelation
  const snapshot = { ...emptyTopicArchive(open.ownerId, 'topic', archiveAt), version: 1, activeVersion: 1,
    entries: [{ ...semantic, status: 'active', origin: 'source_checked', evidence: [source], version: 1, confirmation: null, createdAt: archiveAt, updatedAt: archiveAt }] }
  const reply = { requestId: 'archive-subset', ok: true, value: { kind: 'archive_query', snapshot } }
  assert.deepEqual(parseTopicBridgeReply(reply), reply)
  assert.throws(() => parseTopicBridgeReply({ ...reply, value: { kind: 'archive', snapshot } }))
  assert.throws(() => parseTopicBridgeReply({ ...reply, value: { ...reply.value, snapshot: { ...snapshot, entries: [{ ...snapshot.entries[0], status: 'review_required' }] } } }))
})

test('三个档案工具带实际Agent/callId和明确目标过桥，无第二Host档案数据库', async () => {
  const f = fixture()
  try {
    await f.stream.next()
    const snapshot = emptyTopicArchive(open.ownerId, 'topic', archiveAt)
    const cases = [
      ['translation_list_topic_archive', { topicId: 'topic' }, { kind: 'list_topic_archive', topicId: 'topic' }, 'archive'],
      ['translation_query_archive', { translationSessionId: 's', kinds: ['entity'], forms: ['Synthetic entity'] }, { kind: 'query_archive', translationSessionId: 's', kinds: ['entity'], forms: ['Synthetic entity'] }, 'archive_query'],
      ['translation_upsert_archive', { topicId: 'topic', expectedVersion: 0, entry: archiveEntity }, { kind: 'upsert_archive', topicId: 'topic', expectedVersion: 0, entry: archiveEntity }, 'archive'],
    ]
    let next = f.stream.next()
    for (const [name, args, command, kind] of cases) {
      const result = f.tools.get(name).execute(args, f.exec), frame = (await next).value
      assert.deepEqual(frame.command, command); assert.equal(frame.mainSessionId, open.mainSessionId); assert.equal(frame.callId, f.exec.callId)
      f.inbox.push({ requestId: frame.requestId, ok: true, value: { kind, snapshot } }); next = f.stream.next()
      assert.deepEqual(await result, { kind, snapshot })
    }
    f.controller.abort(); await next
  } finally { await f.close() }
})
