import assert from 'node:assert/strict'
import test from 'node:test'
import { TopicMemoryStore, topicTermsKey } from '../dist/client/topic-memory-store.js'
import { SessionStore } from '../dist/client/session-store.js'
import { DEFAULT_SESSION_SETTINGS, SETTINGS_KEY, historyKey } from '../dist/client/sessions.js'
import { TOPIC_LOCK_NAME } from '../dist/client/topics.js'
import { appendTextUnit, appendSourceCorrection, selectFinalRevision, appendManualRevision, appendTextRevision } from '../dist/client/translation-history.js'

const at = '2026-10-06T00:00:00.000Z'
const model = { provider: 'synthetic', model: 'translator' }
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)) }
class Locks {
  tail = Promise.resolve()
  count = 0
  afterAction
  request(name, action) {
    assert.equal(name, TOPIC_LOCK_NAME); this.count++
    const next = this.tail.then(async () => { const result = await action(); this.afterAction?.(); return result })
    this.tail = next.catch(() => {}); return next
  }
  async block() { let release; this.tail = this.tail.then(() => new Promise(resolve => { release = resolve })); await settle(); return () => release() }
}
class Storage {
  values = new Map()
  locks = new Locks()
  failSet
  failRemove
  get length() { return this.values.size }
  key(index) { return [...this.values.keys()][index] ?? null }
  getItem(key) { return this.values.get(key) ?? null }
  setItem(key, raw) { if (this.failSet === key) throw new Error('synthetic quota'); this.values.set(key, raw) }
  removeItem(key) { if (this.failRemove === key) throw new Error('synthetic remove'); this.values.delete(key) }
}
function changes() { let fn; return { listen(callback) { fn = callback; return () => { fn = undefined } }, send(key) { fn?.(key) } } }
async function fixture(enabled = true, storage = new Storage(), events = {}) {
  if (!storage.getItem(SETTINGS_KEY)) storage.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SESSION_SETTINGS, rememberHistory: enabled }))
  const sessions = new SessionStore(storage, events.sessions?.listen, storage.locks)
  const session = await sessions.createSessionAsync('synthetic-owner')
  assert.ok(session)
  assert.equal(sessions.updateTranslationHistory(session.id, history => appendTextUnit(history,
    { id: 'unit:1', source: '合成 API 原文', targetLanguage: '中文', instruction: '', createdAt: at },
    { id: 'revision:1', operationId: 'operation:1', model, draftVersion: 1, createdAt: at, updatedAt: at, accepted: true, status: 'completed', text: '合成译文', message: null })), true)
  await settle()
  const terms = new TopicMemoryStore(sessions, storage, events.terms?.listen, storage.locks)
  return { storage, sessions, terms, session }
}
function input(session, edits = {}) {
  return { id: 'term:1', expectedEntryVersion: null, sourceLanguage: 'English', targetLanguage: '中文', sourceForms: ['API'], aliases: [], sense: '合成接口', preferred: '接口', forbidden: [],
    evidence: [{ kind: 'source', sessionId: session.id, unitId: 'unit:1', revisionId: null, selectionEventId: null, range: null, role: 'basis' }], origin: 'source_checked', status: 'active', ...edits }
}
const snapshot = f => f.terms.getSnapshot(f.session.ownerId, f.session.topicId)
const apply = (f, edits = {}) => f.terms.apply(f.session.ownerId, f.session.topicId, snapshot(f).version, { kind: 'put', input: input(f.session, edits) })
const query = f => f.terms.query(f.session.ownerId, f.session.topicId, { mode: 'normal', sourceLanguage: 'English', targetLanguage: '中文', forms: ['API'] })

test('同主题子会话共享一份术语，Quick不检索且最终事件不自动提炼', async () => {
  const f = await fixture()
  assert.equal(snapshot(f).entries.length, 0)
  assert.equal((await apply(f)).status, 'updated')
  const child = await f.sessions.createSessionAsync(f.session.ownerId, f.session.id)
  assert.equal(child.topicId, f.session.topicId)
  assert.equal(f.terms.getSnapshot(child.ownerId, child.topicId), snapshot(f))
  assert.equal([...f.storage.values.keys()].filter(key => key.includes(':topic-terms:')).length, 1)
  assert.equal(f.terms.query(child.ownerId, child.topicId, { mode: 'quick', sourceLanguage: 'English', targetLanguage: '中文', forms: ['API'] }).entries.length, 0)
  assert.throws(() => f.terms.getSnapshot('other-owner', child.topicId))
  const other = await f.sessions.createSessionAsync(f.session.ownerId)
  assert.equal(f.terms.getSnapshot(other.ownerId, other.topicId).entries.length, 0)
})

test('history off保留旧资产副本，重新开启保存当前内存而非旁路正文', async () => {
  const f = await fixture()
  await apply(f)
  const key = topicTermsKey(f.session.topicId), saved = f.storage.getItem(key), oldHistory = f.storage.getItem(historyKey(f.session.id))
  assert.equal(await f.sessions.patchSettingsAsync({ rememberHistory: false }), true)
  await apply(f, { expectedEntryVersion: 1, preferred: '合成关闭期间修订' })
  assert.equal(f.storage.getItem(key), saved); assert.equal(f.storage.getItem(historyKey(f.session.id)), oldHistory)
  assert.equal(snapshot(f).entries[0].preferred, '合成关闭期间修订')
  assert.equal(await f.sessions.patchSettingsAsync({ rememberHistory: true }), true)
  await settle()
  assert.equal(JSON.parse(f.storage.getItem(key)).entries[0].preferred, '合成关闭期间修订')
  assert.equal(f.terms.getStatus(f.session.ownerId, f.session.topicId), 'saved')
  assert.equal(f.storage.getItem(key).includes('合成 API 原文'), false)
})

test('source更正后同range旧basis复核，revision与当前source版本分别投影', async () => {
  const f = await fixture()
  const sourceRef = { kind: 'source', sessionId: f.session.id, unitId: 'unit:1', revisionId: null, selectionEventId: null,
    range: { start: 3, end: 6 }, role: 'basis' }
  assert.equal((await apply(f, { evidence: [sourceRef] })).status, 'updated')
  f.sessions.updateTranslationHistory(f.session.id, history => selectFinalRevision(history, 'unit:1', 'revision:1', at))
  const initial = f.terms.readEvidence(f.session.id, 'unit:1')
  assert.equal(initial.sourceVersion, 1)
  assert.equal(initial.source, '合成 API 原文')
  assert.equal(initial.final.sourceVersion, 1)
  assert.equal(initial.final.revisionId, 'revision:1')

  f.sessions.updateTranslationHistory(f.session.id, history => appendSourceCorrection(history, 'unit:1', {
    operationId: 'source-correction:1', expectedVersion: 1, text: '合成 API 原文已纠正', reason: 'synthetic source correction', at,
  }))
  const corrected = f.terms.readEvidence(f.session.id, 'unit:1')
  assert.equal(corrected.sourceVersion, 2)
  assert.equal(Array.from(corrected.source).slice(3, 6).join(''), 'API', 'old range still matches after source correction')
  assert.equal(corrected.final.sourceVersion, 1, 'old selected revision remains an explicitly old-source fact')
  assert.equal(snapshot(f).entries[0].status, 'review_required')
  assert.equal(query(f).entries.length, 0)

  const newSnapshot = snapshot(f)
  const current = await f.terms.apply(f.session.ownerId, f.session.topicId, newSnapshot.version, { kind: 'put', input: input(f.session, {
    id: 'term:source2', expectedEntryVersion: null, evidence: [{ ...sourceRef, sourceVersion: 2 }],
  }) })
  assert.equal(current.status, 'updated')
  assert.equal(current.entry.evidence[0].sourceVersion, 2)
  assert.deepEqual(query(f).entries.map(entry => entry.id), ['term:source2'])
})

test('完全临时主题资产off不落盘，on纳入当前主题且新窗口可恢复', async () => {
  const f = await fixture(false)
  await apply(f)
  const key = topicTermsKey(f.session.topicId)
  assert.equal(f.storage.getItem(key), null)
  await f.sessions.patchSettingsAsync({ rememberHistory: true }); await settle()
  assert.ok(f.storage.getItem(key)); assert.ok(f.storage.getItem(historyKey(f.session.id)))
  const sessions = new SessionStore(f.storage, undefined, f.storage.locks), terms = new TopicMemoryStore(sessions, f.storage, undefined, f.storage.locks)
  assert.equal(terms.getSnapshot(f.session.ownerId, f.session.topicId).entries[0].preferred, '接口')
})

test('恢复仅解析和内存失效，不改写raw；缺失basis不能宣称active', async () => {
  const f = await fixture(); await apply(f)
  const key = topicTermsKey(f.session.topicId), saved = f.storage.getItem(key)
  f.storage.removeItem(historyKey(f.session.id))
  const sessions = new SessionStore(f.storage, undefined, f.storage.locks), terms = new TopicMemoryStore(sessions, f.storage, undefined, f.storage.locks)
  assert.equal(terms.getSnapshot(f.session.ownerId, f.session.topicId).entries[0].status, 'review_required')
  assert.equal(f.storage.getItem(key), saved)
  assert.equal(terms.query(f.session.ownerId, f.session.topicId, { mode: 'normal', sourceLanguage: 'English', targetLanguage: '中文', forms: ['API'] }).entries.length, 0)
})

test('最终选择变化立即失效，选回相同修订也不是相同event', async () => {
  const f = await fixture()
  f.sessions.updateTranslationHistory(f.session.id, history => selectFinalRevision(history, 'unit:1', 'revision:1', at)); await settle()
  const eventId = f.sessions.getTranslationHistory(f.session.id).events.at(-1).id
  const final = { kind: 'final', sessionId: f.session.id, unitId: 'unit:1', revisionId: 'revision:1', selectionEventId: eventId, range: null, role: 'basis' }
  await apply(f, { evidence: [...input(f.session).evidence, final] })
  f.sessions.updateTranslationHistory(f.session.id, history => {
    history = appendManualRevision(history, 'unit:1', { id: 'manual:1', baseRevisionId: 'revision:1', text: '新合成最终', at })
    return selectFinalRevision(history, 'unit:1', 'manual:1', at)
  })
  assert.equal(snapshot(f).entries[0].status, 'review_required'); assert.equal(query(f).entries.length, 0)
  f.sessions.updateTranslationHistory(f.session.id, history => selectFinalRevision(history, 'unit:1', 'revision:1', at)); await settle()
  assert.notEqual(f.terms.readEvidence(f.session.id, 'unit:1').final.selectionEventId, eventId)
  assert.equal(snapshot(f).entries[0].status, 'review_required')
})

test('默认删除保留共享资产与用户规则，最后会话删后新同主题会话可查看', async () => {
  const f = await fixture(); await apply(f)
  await f.terms.apply(f.session.ownerId, f.session.topicId, 1, { kind: 'adopt', id: 'term:1', expectedEntryVersion: 1 })
  const key = topicTermsKey(f.session.topicId), saved = f.storage.getItem(key)
  assert.equal(await f.terms.deleteHistoryAsync([f.session.id], [], f.sessions.captureHistoryVersions([f.session.id])), true)
  await settle()
  assert.equal(snapshot(f).entries[0].status, 'active'); assert.equal(f.storage.getItem(key), saved)
  assert.equal(f.terms.readEvidence(f.session.id, 'unit:1'), undefined)
  const recreated = await f.sessions.createSessionForTopicAsync(f.session.ownerId, f.session.topicId)
  assert.ok(recreated); assert.equal(f.terms.getSnapshot(recreated.ownerId, recreated.topicId).entries.length, 1)
})

test('会话或术语任一冻结版本变化都阻止联动删除，两个范围均保留', async () => {
  for (const changed of ['session', 'term']) {
    const f = await fixture(); await apply(f)
    const versions = f.sessions.captureHistoryVersions([f.session.id]), terms = f.terms.captureForSessions([f.session.id])
    if (changed === 'term') await apply(f, { expectedEntryVersion: 1, preferred: '新版术语' })
    else f.sessions.updateTranslationHistory(f.session.id, history => appendTextRevision(history, 'unit:1', {
      id: 'revision:2', operationId: 'operation:2', model, draftVersion: 2, accepted: true, status: 'completed', createdAt: at, updatedAt: at, text: '新合成译文', message: null }))
    await settle()
    const before = f.storage.getItem(topicTermsKey(f.session.topicId))
    assert.equal(await f.terms.deleteHistoryAsync([f.session.id], [], versions, terms), false)
    assert.ok(f.sessions.getSession(f.session.id)); assert.equal(f.storage.getItem(topicTermsKey(f.session.topicId)), before)
  }
})

test('联动删除真实移除主题raw并阻止旧迟到写，另一主题保留', async () => {
  const f = await fixture(); await apply(f)
  const other = await f.sessions.createSessionAsync(f.session.ownerId)
  await f.terms.apply(other.ownerId, other.topicId, 0, { kind: 'put', input: input(other, { id: 'other-term', origin: 'inferred', status: 'proposal', evidence: [] }) })
  const frozen = f.terms.captureForSessions([f.session.id, f.session.id]); assert.equal(frozen.length, 1)
  assert.equal(await f.terms.deleteHistoryAsync([f.session.id], [], f.sessions.captureHistoryVersions([f.session.id]), frozen), true)
  await settle()
  assert.equal(f.storage.getItem(topicTermsKey(f.session.topicId)), null); assert.equal(snapshot(f).entries.length, 0)
  const late = await f.terms.apply(f.session.ownerId, f.session.topicId, 1, { kind: 'put', input: input(f.session, { expectedEntryVersion: 1 }) })
  assert.equal(late.status, 'stale'); assert.equal(f.storage.getItem(topicTermsKey(f.session.topicId)), null)
  assert.ok(f.storage.getItem(topicTermsKey(other.topicId)))
})

test('术语移除失败准确保留失败范围，不声称会话/资产原子删除', async () => {
  const f = await fixture(); await apply(f)
  const key = topicTermsKey(f.session.topicId); f.storage.failRemove = key
  const result = await f.terms.deleteHistoryAsync([f.session.id], [], f.sessions.captureHistoryVersions([f.session.id]), f.terms.captureForSessions([f.session.id]))
  assert.equal(result, false); assert.equal(f.sessions.getSession(f.session.id), undefined); assert.ok(f.storage.getItem(key))
  assert.match(f.sessions.getNotice(), /所选会话已删除/); assert.match(f.terms.getNotice(), /已删除 0.*未删除 1/)
})

test('显式删除不把off期间其它新条目落盘；on仍可保存剩余内存', async () => {
  const f = await fixture(); await apply(f)
  const key = topicTermsKey(f.session.topicId)
  await f.sessions.patchSettingsAsync({ rememberHistory: false })
  await apply(f, { id: 'term:2', origin: 'inferred', status: 'proposal', evidence: [], preferred: '临时另项' })
  assert.equal(await f.terms.deleteEntryAsync(f.session.ownerId, f.session.topicId, 'term:1', snapshot(f).version, 1), true)
  assert.equal(f.storage.getItem(key), null); assert.deepEqual(snapshot(f).entries.map(entry => entry.id), ['term:2'])
  await f.sessions.patchSettingsAsync({ rememberHistory: true }); await settle()
  assert.deepEqual(JSON.parse(f.storage.getItem(key)).entries.map(entry => entry.id), ['term:2'])
})

test('删除setItem失败不改CAS基准，恢复存储后同确认可重试', async () => {
  const f = await fixture(); await apply(f)
  await apply(f, { id: 'term:2', origin: 'inferred', status: 'proposal', evidence: [] })
  const key = topicTermsKey(f.session.topicId), saved = f.storage.getItem(key), version = snapshot(f).version
  f.storage.failSet = key
  assert.equal(await f.terms.deleteEntryAsync(f.session.ownerId, f.session.topicId, 'term:1', version, 1), false)
  assert.equal(f.storage.getItem(key), saved); assert.equal(snapshot(f).version, version)
  f.storage.failSet = undefined
  assert.equal(await f.terms.deleteEntryAsync(f.session.ownerId, f.session.topicId, 'term:1', version, 1), true)
})

test('实际settings已off而通知未到不会循环排保存，queued最终态不漏写', async () => {
  const f = await fixture(); await apply(f)
  await f.sessions.patchSettingsAsync({ rememberHistory: false })
  await apply(f, { expectedEntryVersion: 1, preferred: '临时' })
  const release = await f.storage.locks.block()
  const enable = f.sessions.patchSettingsAsync({ rememberHistory: true })
  let changed = false
  f.storage.locks.afterAction = () => {
    if (!changed && f.sessions.getSettings().rememberHistory) {
      changed = true; f.storage.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SESSION_SETTINGS, rememberHistory: false }))
    }
  }
  release(); await enable; await settle()
  const count = f.storage.locks.count; await settle(); assert.equal(f.storage.locks.count, count)
  assert.equal(JSON.parse(f.storage.getItem(topicTermsKey(f.session.topicId))).entries[0].preferred, '接口')
})

test('多窗口术语更新不静默覆盖，本地脏内容冲突退出检索并可明确reload', async () => {
  const events = { sessions: changes(), terms: changes() }, f = await fixture(true, new Storage(), events)
  await apply(f)
  const sessions = new SessionStore(f.storage, undefined, f.storage.locks), terms = new TopicMemoryStore(sessions, f.storage, undefined, f.storage.locks)
  await f.sessions.patchSettingsAsync({ rememberHistory: false })
  await apply(f, { expectedEntryVersion: 1, preferred: '本窗口临时' })
  // A second window changes its runtime copy, then explicitly enables saving.
  await sessions.patchSettingsAsync({ rememberHistory: true })
  await terms.apply(f.session.ownerId, f.session.topicId, 1, { kind: 'put', input: input(f.session, { expectedEntryVersion: 1, preferred: '另一窗口' }) })
  events.terms.send(topicTermsKey(f.session.topicId))
  assert.equal(snapshot(f).entries[0].preferred, '本窗口临时'); assert.equal(f.terms.getStatus(f.session.ownerId, f.session.topicId), 'conflict')
  assert.equal(query(f).entries.length, 0)
  assert.equal((await apply(f, { expectedEntryVersion: 2, preferred: '不能覆盖' })).status, 'stale')
  assert.equal(JSON.parse(f.storage.getItem(topicTermsKey(f.session.topicId))).entries[0].preferred, '另一窗口')
  assert.equal(f.terms.reload(f.session.ownerId, f.session.topicId), true)
  assert.equal(snapshot(f).entries[0].preferred, '另一窗口')
})

test('quota写入失败保留已验证内存事实，术语和来源仍可本轮检索', async () => {
  const f = await fixture(); await apply(f)
  f.storage.failSet = historyKey(f.session.id)
  f.sessions.updateTranslationHistory(f.session.id, history => selectFinalRevision(history, 'unit:1', 'revision:1', at))
  await settle()
  assert.equal(f.sessions.getStatus(f.session.id), 'error')
  assert.ok(f.terms.readEvidence(f.session.id, 'unit:1'))
  const key = topicTermsKey(f.session.topicId), saved = f.storage.getItem(key)
  f.storage.failSet = key
  const result = await apply(f, { expectedEntryVersion: 1, preferred: '合成本轮有效' })
  assert.equal(result.status, 'updated'); assert.equal(f.terms.getStatus(f.session.ownerId, f.session.topicId), 'error')
  assert.equal(query(f).entries[0].preferred, '合成本轮有效'); assert.equal(f.storage.getItem(key), saved)
})

test('另一窗口删除屏障即时生效，通知未到也不能检索旧basis或建立核对项', async () => {
  const f = await fixture(); await apply(f)
  const sessions = new SessionStore(f.storage, undefined, f.storage.locks), terms = new TopicMemoryStore(sessions, f.storage, undefined, f.storage.locks)
  await f.sessions.patchSettingsAsync({ rememberHistory: false })
  const key = topicTermsKey(f.session.topicId), saved = f.storage.getItem(key)
  assert.equal(await f.sessions.deleteHistoryAsync([f.session.id], false, [], f.sessions.captureHistoryVersions([f.session.id])), true)
  assert.ok(sessions.getSession(f.session.id)); assert.equal(sessions.isSessionDeleted(f.session.id), true)
  assert.equal(terms.readEvidence(f.session.id, 'unit:1'), undefined)
  assert.equal(terms.query(f.session.ownerId, f.session.topicId, { mode: 'normal', sourceLanguage: 'English', targetLanguage: '中文', forms: ['API'] }).entries.length, 0)
  const result = await terms.apply(f.session.ownerId, f.session.topicId, 1, { kind: 'put', input: input(f.session, { id: 'late-checked' }) })
  assert.equal(result.status, 'invalid'); assert.equal(terms.getSnapshot(f.session.ownerId, f.session.topicId).entries.length, 1)
  assert.equal(f.storage.getItem(key), saved)
})

test('结构合法但owner错配的存储不污染已知topic，界面读取安全且不覆盖raw', async () => {
  const f = await fixture(); await apply(f)
  const key = topicTermsKey(f.session.topicId), foreign = { ...snapshot(f), ownerId: 'synthetic-foreign-owner' }
  f.storage.setItem(key, JSON.stringify(foreign))
  const saved = f.storage.getItem(key), sessions = new SessionStore(f.storage, undefined, f.storage.locks)
  const terms = new TopicMemoryStore(sessions, f.storage, undefined, f.storage.locks)
  let current
  assert.doesNotThrow(() => { current = terms.getSnapshot(f.session.ownerId, f.session.topicId) })
  assert.equal(current.entries.length, 0); assert.match(terms.getNotice(), /无法读取/)
  const result = await terms.apply(f.session.ownerId, f.session.topicId, 0, { kind: 'put', input: input(f.session) })
  assert.equal(result.status, 'stale'); assert.equal(f.storage.getItem(key), saved)
  assert.equal(terms.reload(f.session.ownerId, f.session.topicId), false); assert.equal(f.storage.getItem(key), saved)
})
