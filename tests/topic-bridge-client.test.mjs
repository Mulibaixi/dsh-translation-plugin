import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionStore } from '../dist/client/session-store.js'
import { TopicMemoryStore } from '../dist/client/topic-memory-store.js'
import { TopicArchiveStore, topicArchiveKey } from '../dist/client/topic-archive-store.js'
import { TopicBridgeClient } from '../dist/client/topic-bridge.js'
import { DEFAULT_SESSION_SETTINGS, SETTINGS_KEY } from '../dist/client/sessions.js'
import { appendTextUnit, appendManualRevision, selectFinalRevision } from '../dist/client/translation-history.js'

const at = '2026-10-06T00:00:00.000Z', owner = 'synthetic-bridge-main'
const tick = () => new Promise(resolve => setImmediate(resolve))
class Channel {
  incoming = []; replies = []; wake; closed = false
  send(value) { this.replies.push(structuredClone(value)) }
  push(value) { this.incoming.push(value); this.wake?.(); this.wake = undefined }
  dispose() { this.closed = true; this.wake?.(); this.wake = undefined }
  async *[Symbol.asyncIterator]() {
    while (!this.closed) {
      if (this.incoming.length) yield this.incoming.shift()
      else await new Promise(resolve => { this.wake = resolve })
    }
  }
}
function unit(sessions, session, source = 'Synthetic API source') {
  sessions.updateTranslationHistory(session.id, history => selectFinalRevision(appendTextUnit(history,
    { id: 'synthetic-unit', source, targetLanguage: '中文', instruction: '', createdAt: at },
    { id: 'synthetic-revision', operationId: 'synthetic-operation', model: { provider: 'synthetic', model: 'model-a' }, draftVersion: 1,
      createdAt: at, updatedAt: at, accepted: true, status: 'completed', text: '合成译文', message: null }), 'synthetic-unit', 'synthetic-revision', at))
}
async function fixture(storage, locks) {
  const sessions = new SessionStore(storage, undefined, locks), session = storage ? await sessions.createSessionAsync(owner) : sessions.createSession(owner)
  const terms = new TopicMemoryStore(sessions, storage, undefined, locks)
  const archive = new TopicArchiveStore(sessions, (sessionId, unitId) => terms.readEvidence(sessionId, unitId), storage, undefined, locks)
  const channel = new Channel()
  const bridge = new TopicBridgeClient({ async capabilities() { return { ok: true, value: { ready: true } } },
    connect(identity) { channel.push({ kind: 'ready', ...identity }); return channel } }, sessions, terms, archive)
  const release = bridge.retain(owner)
  await tick()
  assert.equal(bridge.getStatus(owner).ready, true)
  let sequence = 0
  async function request(command, requestId = `synthetic-request-${++sequence}`) {
    const before = channel.replies.length
    channel.push({ kind: 'request', requestId, mainSessionId: owner, callId: `synthetic-call-${sequence}`, command })
    for (let i = 0; i < 50 && channel.replies.length === before; i++) await tick()
    assert.equal(channel.replies.length, before + 1)
    return channel.replies.at(-1)
  }
  return { sessions, session, terms, archive, bridge, channel, request, async close() { release(); await bridge.dispose(); archive.dispose(); terms.dispose(); sessions.dispose() } }
}
function proposal(session, edits = {}) {
  return { kind: 'upsert_term', translationSessionId: session.id, expectedVersion: 0, entry: {
    id: 'synthetic-term', expectedEntryVersion: null, sourceLanguage: 'English', targetLanguage: '中文', sourceForms: ['API'], aliases: [],
    sense: 'Synthetic interface', preferred: '接口', forbidden: [], origin: 'inferred', status: 'proposal', evidence: [], ...edits,
  } }
}
function archiveProposal(topicId, edits = {}, expectedVersion = 0) {
  return { kind: 'upsert_archive', topicId, expectedVersion, entry: {
    kind: 'entity', id: 'synthetic-entity', expectedEntryVersion: null, name: 'API', aliases: ['interface'], description: 'Synthetic interface entity',
    origin: 'inferred', status: 'proposal', evidence: [], ...edits,
  } }
}

test('Client桥：档案保存失败回执准确，查询当前版本后同内容重试不增加语义版本', async () => {
  const values = new Map([[SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SESSION_SETTINGS, rememberHistory: true })]])
  let failKey
  const storage = {
    get length() { return values.size }, key(index) { return [...values.keys()][index] ?? null },
    getItem(key) { return values.get(key) ?? null }, removeItem(key) { values.delete(key) },
    setItem(key, raw) { if (key === failKey) throw new Error('synthetic quota'); values.set(key, raw) },
  }
  const locks = { async request(_name, action) { return await action() } }
  const f = await fixture(storage, locks)
  try {
    const key = topicArchiveKey(f.session.topicId)
    failKey = key
    const failed = await f.request(archiveProposal(f.session.topicId))
    assert.equal(failed.ok, false); assert.equal(failed.error.code, 'save_failed')
    assert.match(failed.error.message, /可能已更新但未保存.*先查询当前版本/)
    const listed = await f.request({ kind: 'list_topic_archive', topicId: f.session.topicId })
    assert.equal(listed.ok, true); assert.equal(listed.value.snapshot.version, 1)
    assert.equal(listed.value.snapshot.entries[0].version, 1); assert.equal(storage.getItem(key), null)
    failKey = undefined
    const retried = await f.request(archiveProposal(f.session.topicId, { expectedEntryVersion: 1 }, 1))
    assert.equal(retried.ok, true); assert.equal(retried.value.snapshot.version, 1)
    assert.equal(retried.value.snapshot.entries[0].version, 1)
    assert.deepEqual(JSON.parse(storage.getItem(key)), retried.value.snapshot)
    assert.equal(f.archive.getStatus(owner, f.session.topicId), 'saved')
    const saved = storage.getItem(key)
    await f.sessions.patchSettingsAsync({ rememberHistory: false })
    failKey = key
    const temporary = await f.request(archiveProposal(f.session.topicId, { expectedEntryVersion: 1, description: 'Synthetic temporary edit' }, 1))
    assert.equal(temporary.ok, true); assert.equal(temporary.value.snapshot.version, 2)
    assert.equal(f.archive.getStatus(owner, f.session.topicId), 'memory'); assert.equal(storage.getItem(key), saved)
  } finally { await f.close() }
})

test('Client桥：真实SessionStore metadata包含档位，跨owner命令拒绝且不泄漏草稿', async () => {
  const f = await fixture()
  try {
    f.sessions.updateSession(f.session.id, { input: 'PRIVATE SYNTHETIC DRAFT' })
    const foreign = f.sessions.createSession('synthetic-other-main')
    const listed = await f.request({ kind: 'list_sessions' })
    assert.equal(listed.ok, true); assert.equal(listed.value.sessions.length, 1)
    assert.equal(listed.value.sessions[0].mode, 'quick')
    assert.equal(listed.value.sessions[0].sequence, 0); assert.equal(listed.value.sessions[0].topicName, f.session.topicName)
    assert.equal(listed.value.sessions[0].remark, ''); assert.equal(listed.value.sessions[0].archived, false)
    assert.equal(listed.value.persistence, undefined)
    assert.ok(!JSON.stringify(listed).includes('PRIVATE SYNTHETIC DRAFT'))
    assert.equal((await f.request({ kind: 'list_terms', translationSessionId: foreign.id })).error.code, 'out_of_scope')
  } finally { await f.close() }
})

test('Client桥：模型后台创建三种起点、理由仅回执，重复请求不再创建，不泄露草稿', async () => {
  const f = await fixture()
  try {
    assert.equal(f.sessions.updateSession(f.session.id, { input: 'PRIVATE SYNTHETIC DRAFT', mode: 'normal', targetLanguage: 'English', instruction: 'Synthetic requirements', model: { provider: 'synthetic', model: 'model-a' } }), true)
    const before = f.sessions.getSession(f.session.id)
    const command = { kind: 'create_session', start: { kind: 'parent_session', translationSessionId: f.session.id }, reason: '继续同主题合成工作' }
    const response = await f.request(command, 'synthetic-create-repeat')
    assert.equal(response.ok, true); assert.equal(response.value.kind, 'session_created'); assert.equal(response.value.persistence, 'runtime_only')
    assert.equal(response.value.reason, command.reason); assert.equal(response.value.session.mode, 'normal'); assert.equal(response.value.session.sequence, 1)
    const child = f.sessions.getSession(response.value.session.id)
    assert.equal(child.input, ''); assert.equal(child.remark, ''); assert.deepEqual(child.model, before.model)
    assert.equal((await f.request(command, 'synthetic-create-repeat')).error.code, 'duplicate_request')
    const existing = await f.request({ kind: 'create_session', start: { kind: 'existing_topic', topicId: f.session.topicId }, reason: '同主题后台分支' })
    assert.equal(existing.value.session.sequence, 2)
    const newTopic = await f.request({ kind: 'create_session', start: { kind: 'new_topic' }, reason: '新主题后台任务' })
    assert.notEqual(newTopic.value.session.topicId, f.session.topicId); assert.equal(newTopic.value.session.mode, 'quick')
    const topics = await f.request({ kind: 'list_topics' })
    assert.equal(topics.value.topics.length, 2); assert.equal(topics.value.topics.find(topic => topic.id === f.session.topicId).sessionIds.length, 3)
    assert.equal(f.sessions.getActiveSession(owner).id, f.session.id); assert.deepEqual(f.sessions.getSession(f.session.id), before)
    assert.ok(!JSON.stringify(response).includes('PRIVATE SYNTHETIC DRAFT')); assert.ok(!JSON.stringify(topics).includes('Synthetic requirements'))
  } finally { await f.close() }
})

test('Client桥：明确 ID 管理名称/备注/归档恢复保留焦点，陈旧与跨 owner 返回错误', async () => {
  const f = await fixture()
  try {
    const created = await f.request({ kind: 'create_session', start: { kind: 'parent_session', translationSessionId: f.session.id }, reason: '合成分支' })
    const child = created.value.session
    const renamed = await f.request({ kind: 'rename_topic', topicId: child.topicId, expectedName: child.topicName, name: '新合成主题' })
    assert.equal(renamed.value.sessions.length, 2); assert.equal(renamed.value.persistence, 'runtime_only')
    const noted = await f.request({ kind: 'set_session_remark', translationSessionId: child.id, expectedRemark: '', remark: '独立分支说明' })
    assert.equal(noted.value.sessions[0].remark, '独立分支说明'); assert.equal(f.sessions.getSession(f.session.id).remark, '')
    assert.equal((await f.request({ kind: 'set_session_remark', translationSessionId: child.id, expectedRemark: '', remark: '陈旧改写' })).error.code, 'conflict')
    assert.equal((await f.request({ kind: 'archive_session', translationSessionId: child.id, expectedArchived: false, archived: true })).value.sessions[0].archived, true)
    assert.equal((await f.request({ kind: 'archive_session', translationSessionId: child.id, expectedArchived: true, archived: false })).value.sessions[0].archived, false)
    assert.equal(f.sessions.getActiveSession(owner).id, f.session.id)
    const foreign = f.sessions.createSession('synthetic-foreign-owner')
    assert.equal((await f.request({ kind: 'rename_topic', topicId: foreign.topicId, expectedName: foreign.topicName, name: '非法范围' })).error.code, 'out_of_scope')
    assert.equal((await f.request({ kind: 'create_session', start: { kind: 'parent_session', translationSessionId: foreign.id }, reason: '非法范围' })).error.code, 'out_of_scope')
    assert.equal((await f.request({ kind: 'list_topic_terms', topicId: foreign.topicId })).error.code, 'out_of_scope')
  } finally { await f.close() }
})

test('Client桥：最后会话删除后主题仍可列出/读术语/改名/续建，不通过已删除会话管理', async () => {
  const f = await fixture()
  try {
    const savedTerm = await f.request(proposal(f.session))
    assert.equal(savedTerm.ok, true)
    assert.equal(await f.sessions.deleteHistoryAsync([f.session.id]), true)
    const topics = await f.request({ kind: 'list_topics' })
    assert.deepEqual(topics.value.topics[0].sessionIds, [])
    assert.equal((await f.request({ kind: 'list_topic_terms', topicId: f.session.topicId })).value.snapshot.entries.length, 1)
    assert.equal((await f.request({ kind: 'set_session_remark', translationSessionId: f.session.id, expectedRemark: '', remark: '旧身份' })).error.code, 'out_of_scope')
    const rename = await f.request({ kind: 'rename_topic', topicId: f.session.topicId, expectedName: f.session.topicName, name: '保留共享档案' })
    assert.deepEqual(rename.value.sessions, [])
    const next = await f.request({ kind: 'create_session', start: { kind: 'existing_topic', topicId: f.session.topicId }, reason: '继续主题' })
    assert.equal(next.value.session.name, '保留共享档案-01'); assert.equal(next.value.session.sequence, 1)
    assert.equal((await f.request({ kind: 'list_terms', translationSessionId: next.value.session.id })).value.snapshot.entries.length, 1)
  } finally { await f.close() }
})

test('Client桥：quick历史须明确升普通再选参考，新版到达不扩大冻结范围，撤回立即拒读', async () => {
  const f = await fixture()
  try {
    unit(f.sessions, f.session)
    assert.equal(f.bridge.publishUnit(owner, f.session.id, 'synthetic-unit'), false)
    f.sessions.updateSession(f.session.id, { mode: 'normal' })
    const command = { kind: 'read_unit', translationSessionId: f.session.id, unitId: 'synthetic-unit' }
    assert.equal((await f.request(command)).error.code, 'reference_not_published')
    assert.equal(f.bridge.publishUnit(owner, f.session.id, 'synthetic-unit'), true)
    const published = await f.request(command)
    assert.equal(published.value.unit.revisions.length, 1)
    assert.ok(published.value.unit.final.selectionEventId)
    f.sessions.updateTranslationHistory(f.session.id, history => appendManualRevision(history, 'synthetic-unit', { id: 'synthetic-manual', baseRevisionId: 'synthetic-revision', text: '人工新译文', at }))
    assert.equal((await f.request(command)).value.unit.revisions.length, 1)
    assert.equal(f.bridge.publishUnit(owner, f.session.id, 'synthetic-unit'), true)
    assert.equal((await f.request(command)).value.unit.revisions.length, 2)
    f.bridge.revokeUnit(owner, f.session.id, 'synthetic-unit')
    assert.equal((await f.request(command)).error.code, 'reference_not_published')
  } finally { await f.close() }
})

test('Client桥：来源依据必须在明确参考中，query只用Store当前生效投影', async () => {
  const f = await fixture()
  try {
    unit(f.sessions, f.session); f.sessions.updateSession(f.session.id, { mode: 'normal' })
    const evidence = [{ kind: 'source', sessionId: f.session.id, unitId: 'synthetic-unit', revisionId: null, selectionEventId: null, range: null, role: 'basis' }]
    const command = proposal(f.session, { origin: 'source_checked', status: 'active', evidence })
    assert.equal((await f.request(command)).error.code, 'reference_not_published')
    f.bridge.publishUnit(owner, f.session.id, 'synthetic-unit')
    assert.equal((await f.request(command)).value.snapshot.entries[0].status, 'active')
    const result = await f.request({ kind: 'query_terms', translationSessionId: f.session.id, sourceLanguage: 'English', targetLanguage: '中文', forms: ['API'] })
    assert.equal(result.value.snapshot.entries.length, 1)
    const neighbor = f.sessions.createSession(owner)
    assert.equal((await f.request({ kind: 'query_terms', translationSessionId: neighbor.id, sourceLanguage: 'English', targetLanguage: '中文', forms: ['API'] })).value.snapshot.entries.length, 0)
  } finally { await f.close() }
})

test('Client桥：重复request不重复修改，模型不能冒充用户采用', async () => {
  const f = await fixture()
  try {
    const command = proposal(f.session)
    const first = await f.request(command, 'synthetic-repeat')
    assert.equal(first.value.snapshot.entries[0].origin, 'inferred')
    assert.equal((await f.request(command, 'synthetic-repeat')).error.code, 'duplicate_request')
    assert.equal(f.terms.getSnapshot(owner, f.session.topicId).version, 1)
    const term = first.value.snapshot.entries[0]
    await f.terms.apply(owner, f.session.topicId, first.value.snapshot.version, { kind: 'adopt', id: term.id, expectedEntryVersion: term.version })
    const current = f.terms.getSnapshot(owner, f.session.topicId)
    const rewrite = { ...command, expectedVersion: current.version, entry: { ...command.entry, expectedEntryVersion: current.entries[0].version, preferred: '错误覆盖' } }
    assert.equal((await f.request(rewrite)).error.code, 'requires_user_action')
    assert.equal(f.terms.getSnapshot(owner, f.session.topicId).entries[0].preferred, '接口')
  } finally { await f.close() }
})

test('Client桥：大正文拒绝提供参考而不截断，删除会话释放已公开正文', async () => {
  const f = await fixture()
  try {
    unit(f.sessions, f.session, '合'.repeat(100000)); f.sessions.updateSession(f.session.id, { mode: 'normal' })
    assert.equal(f.bridge.publishUnit(owner, f.session.id, 'synthetic-unit'), false)
    assert.equal(f.bridge.isPublished(owner, f.session.id, 'synthetic-unit'), false)
    const small = f.sessions.createSession(owner)
    unit(f.sessions, small); f.sessions.updateSession(small.id, { mode: 'normal' })
    assert.equal(f.bridge.publishUnit(owner, small.id, 'synthetic-unit'), true)
    await f.sessions.deleteHistoryAsync([small.id], false, [], f.sessions.captureHistoryVersions([small.id]))
    assert.equal(f.bridge.isPublished(owner, small.id, 'synthetic-unit'), false)
  } finally { await f.close() }
})

test('Client桥：同owner多个panel只连一次，occupied原因清晰，异步清理异常被观察', async () => {
  const sessions = new SessionStore(), terms = new TopicMemoryStore(sessions)
  const archive = new TopicArchiveStore(sessions, (sessionId, unitId) => terms.readEvidence(sessionId, unitId))
  let calls = 0, closes = 0
  const bridge = new TopicBridgeClient({ async capabilities() { return { ok: true, value: { ready: true } } }, connect() {
    calls++
    return { send() {}, async dispose() { closes++; throw new Error('synthetic cleanup failure') }, async *[Symbol.asyncIterator]() { throw Object.assign(new Error('synthetic'), { code: 'connection_occupied' }) } }
  } }, sessions, terms, archive)
  try {
    const first = bridge.retain(owner), second = bridge.retain(owner)
    await tick(); assert.equal(calls, 1); assert.match(bridge.getStatus(owner).reason, /另一窗口/)
    first(); second(); await tick(); assert.ok(closes >= 1)
    await bridge.dispose()
  } finally { await bridge.dispose(); archive.dispose(); terms.dispose(); sessions.dispose() }
})

test('Client档案桥：同topic权威共享，原文依据须公开，quick查询为空且不读取当前草稿', async () => {
  const f = await fixture()
  try {
    unit(f.sessions, f.session)
    const quick = f.sessions.createSession(owner, f.session.id)
    f.sessions.updateSession(f.session.id, { mode: 'normal', input: 'PRIVATE ARCHIVE DRAFT' })
    const evidence = [{ kind: 'source', sessionId: f.session.id, unitId: 'synthetic-unit', revisionId: null, selectionEventId: null, range: null, role: 'basis' }]
    const command = archiveProposal(f.session.topicId, { origin: 'source_checked', status: 'active', evidence })
    assert.equal((await f.request(command)).error.code, 'reference_not_published')
    assert.equal(f.bridge.publishUnit(owner, f.session.id, 'synthetic-unit'), true)
    const saved = await f.request(command)
    assert.equal(saved.ok, true); assert.equal(saved.value.kind, 'archive'); assert.equal(saved.value.snapshot.entries[0].status, 'active')
    assert.deepEqual(saved.value.snapshot, f.archive.getSnapshot(owner, f.session.topicId))
    const query = { kind: 'query_archive', translationSessionId: f.session.id, kinds: ['entity'], forms: ['interface'] }
    assert.equal((await f.request(query)).value.snapshot.entries[0].name, 'API')
    const child = f.sessions.createSession(owner, f.session.id)
    assert.equal((await f.request({ ...query, translationSessionId: child.id })).value.snapshot.entries[0].name, 'API')
    assert.equal(f.sessions.getSession(child.id).mode, 'normal')
    assert.equal(f.sessions.getSession(quick.id).mode, 'quick'); assert.equal(quick.topicId, f.session.topicId)
    assert.deepEqual((await f.request({ ...query, translationSessionId: quick.id })).value.snapshot.entries, [])
    assert.deepEqual((await f.request({ ...query, forms: ['APIx'] })).value.snapshot.entries, [])
    const foreign = f.sessions.createSession('foreign-archive-owner')
    for (const command of [{ kind: 'list_topic_archive', topicId: foreign.topicId }, archiveProposal(foreign.topicId), { ...query, translationSessionId: foreign.id }]) {
      assert.equal((await f.request(command)).error.code, 'out_of_scope')
    }
    const listed = await f.request({ kind: 'list_topic_archive', topicId: f.session.topicId })
    for (const forbidden of ['PRIVATE ARCHIVE DRAFT', 'Synthetic API source', '合成译文', 'model', 'callRecord', 'revisions']) assert.ok(!JSON.stringify(listed).includes(forbidden), forbidden)
  } finally { await f.close() }
})

test('Client档案桥：事实及关系查询不附带实体，引用投影经真实边界解析且用户采用不可覆盖', async () => {
  const f = await fixture()
  try {
    unit(f.sessions, f.session, 'Synthetic API and DSH source'); f.sessions.updateSession(f.session.id, { mode: 'normal' })
    f.bridge.publishUnit(owner, f.session.id, 'synthetic-unit')
    const evidence = [{ kind: 'source', sessionId: f.session.id, unitId: 'synthetic-unit', revisionId: null, selectionEventId: null, range: null, role: 'basis' }]
    const first = await f.request(archiveProposal(f.session.topicId, { origin: 'source_checked', status: 'active', evidence }))
    const second = await f.request(archiveProposal(f.session.topicId, { id: 'second-entity', name: 'DSH', aliases: [], origin: 'source_checked', status: 'active', evidence }, first.value.snapshot.version))
    const common = { expectedEntryVersion: null, origin: 'source_checked', status: 'active', evidence }
    const fact = await f.request({ kind: 'upsert_archive', topicId: f.session.topicId, expectedVersion: second.value.snapshot.version,
      entry: { ...common, kind: 'fact', id: 'synthetic-fact', title: 'Interface fact', body: 'Synthetic published fact', entityIds: ['synthetic-entity'] } })
    const relation = await f.request({ kind: 'upsert_archive', topicId: f.session.topicId, expectedVersion: fact.value.snapshot.version,
      entry: { ...common, kind: 'relation', id: 'synthetic-relation', sourceEntityId: 'synthetic-entity', relation: 'uses', targetEntityId: 'second-entity', description: 'Synthetic published relation' } })
    assert.equal(relation.ok, true)
    for (const [kind, id] of [['fact', 'synthetic-fact'], ['relation', 'synthetic-relation']]) {
      const query = await f.request({ kind: 'query_archive', translationSessionId: f.session.id, kinds: [kind], forms: ['API'] })
      assert.equal(query.ok, true); assert.equal(query.value.kind, 'archive_query')
      assert.deepEqual(query.value.snapshot.entries.map(entry => entry.id), [id]); assert.equal(f.bridge.getStatus(owner).ready, true)
    }
    const adopted = await f.archive.apply(owner, f.session.topicId, relation.value.snapshot.version, { kind: 'adopt', id: 'synthetic-fact', expectedEntryVersion: fact.value.snapshot.entries.find(entry => entry.id === 'synthetic-fact').version })
    assert.equal(adopted.status, 'updated')
    const fixed = adopted.snapshot.entries.find(entry => entry.id === 'synthetic-fact')
    const rewrite = await f.request({ kind: 'upsert_archive', topicId: f.session.topicId, expectedVersion: adopted.snapshot.version,
      entry: { ...common, kind: 'fact', id: fixed.id, expectedEntryVersion: fixed.version, title: fixed.title, body: 'Model attempted overwrite', entityIds: fixed.entityIds } })
    assert.equal(rewrite.error.code, 'requires_user_action'); assert.equal(f.archive.getSnapshot(owner, f.session.topicId).entries.find(entry => entry.id === fixed.id).body, 'Synthetic published fact')
  } finally { await f.close() }
})

test('Client档案桥：孤立保留主题可列出和提案，陈旧/重复请求不重复写且不激活会话', async () => {
  const f = await fixture()
  try {
    const command = archiveProposal(f.session.topicId)
    const first = await f.request(command, 'archive-repeat')
    assert.equal(first.value.snapshot.entries[0].status, 'proposal')
    assert.equal((await f.request(command, 'archive-repeat')).error.code, 'duplicate_request')
    assert.equal((await f.request(command)).error.code, 'stale')
    await f.sessions.deleteHistoryAsync([f.session.id])
    const listed = await f.request({ kind: 'list_topic_archive', topicId: f.session.topicId })
    assert.equal(listed.ok, true); assert.equal(listed.value.snapshot.entries[0].id, 'synthetic-entity')
    const next = await f.request(archiveProposal(f.session.topicId, { id: 'orphan-entity', name: 'Retained entity' }, listed.value.snapshot.version))
    assert.equal(next.ok, true); assert.equal(next.value.snapshot.entries.length, 2)
    assert.equal(f.sessions.getAvailableSessions(owner).length, 0)
    assert.equal((await f.request({ kind: 'query_archive', translationSessionId: f.session.id, kinds: ['entity'], forms: ['API'] })).error.code, 'out_of_scope')
  } finally { await f.close() }
})
