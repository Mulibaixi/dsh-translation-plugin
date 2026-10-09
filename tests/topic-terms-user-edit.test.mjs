import assert from 'node:assert/strict'
import test from 'node:test'
import {
  emptyTopicTerms, putUserTopicTerm, decodeTopicTermUserInput, decodeTopicTermSnapshot, decodeTopicTermPut,
  putTopicTerm, adoptTopicTerm, disableTopicTerm, reconcileTopicTerms, queryTopicTerms,
} from '../dist/memory/topic-terms.js'
import { TopicMemoryStore, topicTermsKey } from '../dist/client/topic-memory-store.js'
import { SessionStore } from '../dist/client/session-store.js'
import { SETTINGS_KEY, DEFAULT_SESSION_SETTINGS, historyKey } from '../dist/client/sessions.js'
import { TOPIC_LOCK_NAME } from '../dist/client/topics.js'
import { parseTopicBridgeCommand } from '../dist/shared/topic-bridge.js'

const at = '2026-10-06T01:00:00.000Z', later = '2026-10-06T02:00:00.000Z'
const ownerId = 'synthetic-user-edit-owner', topicId = 'synthetic-user-edit-topic'
const empty = () => emptyTopicTerms(ownerId, topicId, at)
const action = { eventId: 'synthetic-user-save:1', at }
function input(edits = {}) {
  return { id: 'synthetic-term', expectedEntryVersion: null, sourceLanguage: 'English', targetLanguage: '中文', sourceForms: ['API'], aliases: [],
    sense: '合成接口义项', preferred: '接口', forbidden: [], ...edits }
}
function modelInput(edits = {}) { return { ...input(), evidence: [], origin: 'inferred', status: 'proposal', ...edits } }
const save = (snapshot = empty(), edits = {}, event = action) => putUserTopicTerm(snapshot, input(edits), event)
const query = snapshot => queryTopicTerms(snapshot, { mode: 'normal', ownerId, topicId, sourceLanguage: 'English', targetLanguage: '中文', forms: ['API'] }, () => undefined)

test('用户术语边界只接受可编辑语义，不接受确认/来源/权限字段，模型权限不扩大', () => {
  assert.deepEqual(decodeTopicTermUserInput(input({ id: null })), input({ id: null }))
  for (const edits of [{ confirmation: action }, { origin: 'user_explicit' }, { status: 'active' }, { evidence: [] }, { credentials: 'synthetic' },
    { sourceForms: [] }, { preferred: '' }, { forbidden: ['接口'] }, { id: null, expectedEntryVersion: 1 }, { sense: '😀'.repeat(4001) }]) {
    assert.equal(decodeTopicTermUserInput(input(edits)), undefined)
  }
  assert.ok(decodeTopicTermUserInput(input({ sense: '😀'.repeat(4000) })))
  assert.equal(decodeTopicTermPut(modelInput({ origin: 'user_explicit', status: 'active' })), undefined)
  assert.throws(() => parseTopicBridgeCommand({ kind: 'user_put', input: input() }))
})

test('用户新术语一次保存即生效，候选与确认版本保持原schema兼容且不复制证据', () => {
  const result = save()
  assert.equal(result.status, 'updated'); assert.equal(result.entry.id, 'synthetic-term')
  assert.equal(result.entry.origin, 'user_explicit'); assert.equal(result.entry.status, 'active')
  assert.equal(result.entry.version, 2); assert.equal(result.snapshot.version, 2); assert.equal(result.snapshot.activeVersion, 1)
  assert.deepEqual(result.entry.confirmation, { ...action, adoptedEntryVersion: 1 })
  assert.deepEqual(result.entry.evidence, []); assert.equal(query(result.snapshot).length, 1)
  assert.ok(decodeTopicTermSnapshot(result.snapshot)); assert.deepEqual(empty().entries, [])
})

test('用户原位编辑active规则保留id/createdAt，原证据仅转example且模型仍不能覆盖', () => {
  const evidence = [{ kind: 'source', sessionId: 'synthetic-source-session', unitId: 'synthetic-unit', revisionId: null, selectionEventId: null, range: { start: 0, end: 3 }, role: 'basis' }]
  const checked = putTopicTerm(empty(), modelInput({ origin: 'source_checked', status: 'active', evidence }), () => ({ ownerId, topicId, sourceVersion: 1, source: 'API synthetic', final: null }), at)
  const original = adoptTopicTerm(checked.snapshot, checked.entry.id, checked.entry.version, action)
  const changed = save(original.snapshot, { expectedEntryVersion: original.entry.version, preferred: '程序接口' }, { eventId: 'synthetic-user-save:2', at: later })
  assert.equal(changed.status, 'updated'); assert.equal(changed.entry.id, original.entry.id); assert.equal(changed.entry.createdAt, at)
  assert.equal(changed.entry.version, original.entry.version + 1); assert.equal(changed.snapshot.activeVersion, original.snapshot.activeVersion + 1)
  assert.deepEqual(changed.entry.evidence, evidence.map(ref => ({ ...ref, role: 'example' })))
  assert.equal(changed.entry.confirmation.adoptedEntryVersion, original.entry.version); assert.equal(changed.entry.confirmation.eventId, 'synthetic-user-save:2')
  assert.equal(putTopicTerm(changed.snapshot, modelInput({ expectedEntryVersion: changed.entry.version, preferred: '模型覆盖' }), () => undefined, later).status, 'requires_user_action')
  assert.equal(reconcileTopicTerms(changed.snapshot, () => undefined, later), changed.snapshot)
  assert.ok(decodeTopicTermSnapshot(changed.snapshot)); assert.equal(JSON.stringify(changed.snapshot).includes('API synthetic'), false)
})

test('用户保存proposal/disabled/review项直接作为确认规则，无二次采用且保留来源', () => {
  const proposal = putTopicTerm(empty(), modelInput(), () => undefined, at)
  const disabled = disableTopicTerm(proposal.snapshot, proposal.entry.id, proposal.entry.version, at)
  const reference = { kind: 'source', sessionId: 'synthetic-missing-session', unitId: 'synthetic-unit', revisionId: null, selectionEventId: null, range: null, role: 'basis' }
  const based = putTopicTerm(empty(), modelInput({ evidence: [reference] }), () => undefined, at)
  const review = reconcileTopicTerms(based.snapshot, () => undefined, later)
  for (const snapshot of [proposal.snapshot, disabled.snapshot, review]) {
    const old = snapshot.entries[0], saved = save(snapshot, { expectedEntryVersion: old.version }, { ...action, at: later })
    assert.equal(saved.entry.status, 'active'); assert.equal(saved.entry.origin, 'user_explicit')
    assert.equal(saved.entry.version, old.version + 1); assert.equal(saved.entry.createdAt, old.createdAt)
    assert.deepEqual(saved.entry.evidence, old.evidence.map(ref => ({ ...ref, role: 'example' })))
    assert.ok(decodeTopicTermSnapshot(saved.snapshot))
  }
})

test('用户陈旧/冲突提交保留整个档案，相同active内容不增版本或确认事件', () => {
  const first = save(), next = save(first.snapshot, { id: 'synthetic-term:2', sourceForms: ['SDK'], preferred: '开发包' })
  const stale = save(next.snapshot, { expectedEntryVersion: first.entry.version - 1, preferred: '旧编辑' })
  assert.equal(stale.status, 'stale'); assert.equal(stale.snapshot, next.snapshot)
  const conflict = save(next.snapshot, { id: 'synthetic-term:2', expectedEntryVersion: next.entry.version, sourceForms: ['API'], preferred: '冲突译法' })
  assert.equal(conflict.status, 'conflict'); assert.equal(conflict.snapshot, next.snapshot)
  const same = save(next.snapshot, { expectedEntryVersion: first.entry.version }, { eventId: 'unused-event', at: later })
  assert.equal(same.status, 'unchanged'); assert.equal(same.snapshot, next.snapshot); assert.equal(same.entry.confirmation.eventId, action.eventId)
})

class Locks {
  tail = Promise.resolve(); count = 0
  request(name, action) { assert.equal(name, TOPIC_LOCK_NAME); this.count++; const next = this.tail.then(action); this.tail = next.catch(() => {}); return next }
  block() { let release; const gate = new Promise(resolve => { release = resolve }); this.tail = this.tail.then(() => gate); return release }
}
class Storage {
  values = new Map(); locks = new Locks(); writes = []; failKey
  get length() { return this.values.size }
  key(index) { return [...this.values.keys()][index] ?? null }
  getItem(key) { return this.values.get(key) ?? null }
  setItem(key, raw) { if (key === this.failKey) throw new Error('synthetic quota'); this.values.set(key, raw); this.writes.push(key) }
  removeItem(key) { this.values.delete(key) }
}
const settle = () => new Promise(resolve => setImmediate(resolve))
async function fixture(enabled = true, storage = new Storage()) {
  if (storage.getItem(SETTINGS_KEY) === null) storage.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SESSION_SETTINGS, rememberHistory: enabled }))
  const sessions = new SessionStore(storage, undefined, storage.locks), session = await sessions.createSessionAsync(ownerId)
  const terms = new TopicMemoryStore(sessions, storage, undefined, storage.locks)
  const snapshot = () => terms.getSnapshot(ownerId, session.topicId)
  const save = (data = input({ id: null }), version = snapshot().version) => terms.saveUserTerm(ownerId, session.topicId, version, data)
  return { storage, sessions, session, terms, snapshot, save, close() { terms.dispose(); sessions.dispose() } }
}

test('Store用户新增/原位修改仅一锁一次写入，确认事件由Store生成且会话正文保持不变', async () => {
  const f = await fixture()
  try {
    const history = f.storage.getItem(historyKey(f.session.id)), count = f.storage.locks.count, writes = f.storage.writes.length
    const first = await f.save()
    assert.equal(first.status, 'updated'); assert.match(first.entry.id, /^term:/); assert.match(first.entry.confirmation.eventId, /^term-user-save:/)
    assert.equal(f.storage.locks.count, count + 1); assert.equal(f.storage.writes.length, writes + 1)
    assert.equal(f.storage.writes.at(-1), topicTermsKey(f.session.topicId))
    const second = await f.save(input({ id: first.entry.id, expectedEntryVersion: first.entry.version, preferred: '程序接口' }))
    assert.equal(second.entry.id, first.entry.id); assert.equal(second.entry.createdAt, first.entry.createdAt)
    assert.equal(second.entry.version, first.entry.version + 1); assert.equal(f.snapshot().entries.length, 1)
    assert.equal(f.storage.getItem(historyKey(f.session.id)), history); assert.ok(decodeTopicTermSnapshot(JSON.parse(f.storage.getItem(topicTermsKey(f.session.topicId)))))
  } finally { f.close() }
})

test('Store用户保存遵守off/on旧副本策略，off期新增/编辑不上盘，重新开启恢复当前事实', async () => {
  const f = await fixture()
  try {
    const first = await f.save(), key = topicTermsKey(f.session.topicId), raw = f.storage.getItem(key)
    assert.equal(await f.sessions.patchSettingsAsync({ rememberHistory: false }), true)
    const updated = await f.save(input({ id: first.entry.id, expectedEntryVersion: first.entry.version, preferred: '运行期接口' }))
    assert.equal(updated.status, 'updated'); assert.equal(f.storage.getItem(key), raw)
    assert.equal((await f.save(input({ id: null, sourceForms: ['SDK'], preferred: '开发包' }))).status, 'updated')
    assert.equal(f.storage.getItem(key), raw); assert.equal(f.terms.getStatus(ownerId, f.session.topicId), 'memory')
    assert.equal(await f.sessions.patchSettingsAsync({ rememberHistory: true }), true); await settle()
    assert.equal(JSON.parse(f.storage.getItem(key)).entries.length, 2)
    assert.equal(JSON.parse(f.storage.getItem(key)).entries[0].preferred, '运行期接口')
  } finally { f.close() }
})

test('Store用户expectedSnapshot/entry在锁内拒绝陈旧保存，表单权限字段无法注入', async () => {
  const f = await fixture(false)
  try {
    const first = await f.save(), version = f.snapshot().version, release = f.storage.locks.block()
    const one = f.save(input({ id: first.entry.id, expectedEntryVersion: first.entry.version, preferred: '第一个编辑' }), version)
    const two = f.save(input({ id: first.entry.id, expectedEntryVersion: first.entry.version, preferred: '第二个编辑' }), version)
    release(); assert.equal((await one).status, 'updated'); assert.equal((await two).status, 'stale')
    const current = f.snapshot()
    assert.equal((await f.save(input({ id: first.entry.id, expectedEntryVersion: first.entry.version, preferred: '旧条目' }))).status, 'stale')
    assert.equal((await f.save(input({ id: null, confirmation: { eventId: 'fake', at } }))).status, 'invalid')
    assert.equal(f.snapshot(), current)
  } finally { f.close() }
})

test('Store跨窗口用户编辑遇raw冲突不覆盖，保存失败保留可查当前规则', async () => {
  const f = await fixture()
  try {
    const first = await f.save(), otherSessions = new SessionStore(f.storage, undefined, f.storage.locks)
    const other = new TopicMemoryStore(otherSessions, f.storage, undefined, f.storage.locks)
    try {
      const otherResult = await other.saveUserTerm(ownerId, f.session.topicId, f.snapshot().version, input({ id: first.entry.id, expectedEntryVersion: first.entry.version, preferred: '另一窗口接口' }))
      assert.equal(otherResult.status, 'updated')
      const raw = f.storage.getItem(topicTermsKey(f.session.topicId))
      assert.equal((await f.save(input({ id: first.entry.id, expectedEntryVersion: first.entry.version, preferred: '旧窗口覆盖' }))).status, 'stale')
      assert.equal(f.storage.getItem(topicTermsKey(f.session.topicId)), raw)
      assert.equal(f.terms.reload(ownerId, f.session.topicId), true)
      const current = f.snapshot().entries[0]; f.storage.failKey = topicTermsKey(f.session.topicId)
      assert.equal((await f.save(input({ id: current.id, expectedEntryVersion: current.version, preferred: '未保存但当前有效' }))).status, 'updated')
      assert.equal(f.terms.getStatus(ownerId, f.session.topicId), 'error'); assert.equal(f.storage.getItem(topicTermsKey(f.session.topicId)), raw)
      assert.equal(f.terms.query(ownerId, f.session.topicId, { mode: 'normal', sourceLanguage: 'English', targetLanguage: '中文', forms: ['API'] }).entries[0].preferred, '未保存但当前有效')
    } finally { other.dispose(); otherSessions.dispose() }
  } finally { f.close() }
})

test('Store用户编辑不会越topic管理，conflict不修改其他规则，相同保存无多余写入', async () => {
  const f = await fixture()
  try {
    const first = await f.save(), before = f.snapshot(), writes = f.storage.writes.length
    assert.equal((await f.save(input({ id: first.entry.id, expectedEntryVersion: first.entry.version }))).status, 'unchanged')
    assert.equal(f.snapshot(), before); assert.equal(f.storage.writes.length, writes)
    assert.equal((await f.save(input({ id: null, preferred: '冲突新译法' }))).status, 'conflict'); assert.equal(f.snapshot(), before)
    assert.equal((await f.terms.saveUserTerm(ownerId, 'synthetic-unknown-topic', 0, input({ id: null }))).status, 'stale')
    assert.equal(f.terms.query(ownerId, f.session.topicId, { mode: 'quick', sourceLanguage: 'English', targetLanguage: '中文', forms: ['API'] }).entries.length, 0)
  } finally { f.close() }
})
