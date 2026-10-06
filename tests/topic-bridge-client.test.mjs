import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionStore } from '../dist/client/session-store.js'
import { TopicMemoryStore } from '../dist/client/topic-memory-store.js'
import { TopicBridgeClient } from '../dist/client/topic-bridge.js'
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
async function fixture() {
  const sessions = new SessionStore(), session = sessions.createSession(owner), terms = new TopicMemoryStore(sessions)
  const channel = new Channel()
  const bridge = new TopicBridgeClient({ async capabilities() { return { ok: true, value: { ready: true } } },
    connect(identity) { channel.push({ kind: 'ready', ...identity }); return channel } }, sessions, terms)
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
  return { sessions, session, terms, bridge, channel, request, async close() { release(); await bridge.dispose(); terms.dispose(); sessions.dispose() } }
}
function proposal(session, edits = {}) {
  return { kind: 'upsert_term', translationSessionId: session.id, expectedVersion: 0, entry: {
    id: 'synthetic-term', expectedEntryVersion: null, sourceLanguage: 'English', targetLanguage: '中文', sourceForms: ['API'], aliases: [],
    sense: 'Synthetic interface', preferred: '接口', forbidden: [], origin: 'inferred', status: 'proposal', evidence: [], ...edits,
  } }
}

test('Client桥：真实SessionStore metadata包含档位，跨owner命令拒绝且不泄漏草稿', async () => {
  const f = await fixture()
  try {
    f.sessions.updateSession(f.session.id, { input: 'PRIVATE SYNTHETIC DRAFT' })
    const foreign = f.sessions.createSession('synthetic-other-main')
    const listed = await f.request({ kind: 'list_sessions' })
    assert.equal(listed.ok, true); assert.equal(listed.value.sessions.length, 1)
    assert.equal(listed.value.sessions[0].mode, 'quick')
    assert.ok(!JSON.stringify(listed).includes('PRIVATE SYNTHETIC DRAFT'))
    assert.equal((await f.request({ kind: 'list_terms', translationSessionId: foreign.id })).error.code, 'out_of_scope')
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
  let calls = 0, closes = 0
  const bridge = new TopicBridgeClient({ async capabilities() { return { ok: true, value: { ready: true } } }, connect() {
    calls++
    return { send() {}, async dispose() { closes++; throw new Error('synthetic cleanup failure') }, async *[Symbol.asyncIterator]() { throw Object.assign(new Error('synthetic'), { code: 'connection_occupied' }) } }
  } }, sessions, terms)
  try {
    const first = bridge.retain(owner), second = bridge.retain(owner)
    await tick(); assert.equal(calls, 1); assert.match(bridge.getStatus(owner).reason, /另一窗口/)
    first(); second(); await tick(); assert.ok(closes >= 1)
    await bridge.dispose()
  } finally { await bridge.dispose(); terms.dispose(); sessions.dispose() }
})
