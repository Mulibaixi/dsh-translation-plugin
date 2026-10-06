import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionStore } from '../dist/client/session-store.js'
import { DEFAULT_SESSION_SETTINGS, SETTINGS_KEY, historyKey } from '../dist/client/sessions.js'
import { TOPIC_LOCK_NAME, topicIdentityKey, topicNameKey } from '../dist/client/topics.js'

class Locks {
  tail = Promise.resolve()
  request(name, action) {
    assert.equal(name, TOPIC_LOCK_NAME)
    const next = this.tail.then(action); this.tail = next.catch(() => {}); return next
  }
  block() { let release; const gate = new Promise(resolve => { release = resolve }); this.tail = this.tail.then(() => gate); return release }
}
class Storage {
  values = new Map(); locks = new Locks(); failKey
  get length() { return this.values.size }
  key(index) { return [...this.values.keys()][index] ?? null }
  getItem(key) { return this.values.get(key) ?? null }
  setItem(key, value) { if (key === this.failKey || (this.failKey === 'history' && key.startsWith('dsh-translation-plugin:history:'))) throw new Error('synthetic quota'); this.values.set(key, value) }
  removeItem(key) { this.values.delete(key) }
}
const owner = 'synthetic-managed-owner', tick = () => new Promise(resolve => setImmediate(resolve))
function stored(rememberHistory = true) {
  const storage = new Storage()
  storage.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SESSION_SETTINGS, rememberHistory }))
  return storage
}
function create(store, start = { kind: 'new_topic' }) { return store.createManagedSessionAsync(owner, start) }
function created(result) { assert.equal(result.ok, true); assert.equal(result.sessions.length, 1); return result.sessions[0] }

test('会话管理：纯运行期后台三种创建不抢焦点，父配置继承且草稿/备注不继承', async () => {
  const store = new SessionStore(); let notifications = 0; const stop = store.subscribe(() => notifications++)
  try {
    const original = store.createSession(owner)
    assert.equal(store.updateSession(original.id, { mode: 'normal', targetLanguage: 'English', instruction: 'Synthetic instructions', maxInputChars: 333,
      model: { provider: 'synthetic', model: 'translator' }, input: 'PRIVATE SYNTHETIC DRAFT', remark: 'parent only' }), true)
    const before = store.getSession(original.id)
    const childResult = await create(store, { kind: 'parent_session', translationSessionId: original.id }), child = created(childResult)
    assert.equal(childResult.persistence, 'runtime_only'); assert.equal(child.parentId, original.id)
    assert.equal(child.mode, 'normal'); assert.equal(child.targetLanguage, 'English'); assert.equal(child.instruction, before.instruction)
    assert.equal(child.maxInputChars, 333); assert.deepEqual(child.model, before.model)
    assert.equal(child.input, ''); assert.equal(child.remark, ''); assert.equal(child.sequence, 1)
    const neighbor = created(await create(store, { kind: 'existing_topic', topicId: original.topicId }))
    assert.equal(neighbor.topicId, original.topicId); assert.equal(neighbor.sequence, 2)
    const newTopic = created(await create(store))
    assert.notEqual(newTopic.topicId, original.topicId); assert.equal(newTopic.sequence, 0); assert.equal(newTopic.mode, 'quick')
    assert.equal(store.getActiveSession(owner).id, original.id); assert.deepEqual(store.getSession(original.id), before)
    assert.ok(notifications >= 3)
  } finally { stop(); store.dispose() }
})

test('会话管理：显式后台参数保持焦点，原 UI 创建和恢复仍选择会话', async () => {
  const store = new SessionStore()
  try {
    const first = store.createSession(owner), background = await store.createSessionAsync(owner, first.id, false)
    assert.equal(store.getActiveSession(owner).id, first.id)
    assert.equal(store.archiveSession(owner, background.id), true)
    assert.equal(store.archiveSession(owner, background.id, false, false), true)
    assert.equal(store.getActiveSession(owner).id, first.id)
    assert.equal(store.archiveSession(owner, background.id), true)
    assert.equal(store.archiveSession(owner, background.id, false), true)
    assert.equal(store.getActiveSession(owner).id, background.id)
    const next = await store.createSessionAsync(owner)
    assert.equal(store.getActiveSession(owner).id, next.id)
  } finally { store.dispose() }
})

test('会话管理：工具归档恢复不抢其他会话焦点，名称共享/备注独立且不改执行事实', async () => {
  const store = new SessionStore()
  try {
    const first = store.createSession(owner), child = created(await create(store, { kind: 'parent_session', translationSessionId: first.id }))
    assert.equal(store.updateSession(first.id, { input: 'PRIVATE SYNTHETIC DRAFT' }), true)
    assert.equal((await store.renameTopicAsync(owner, first.topicId, first.topicName, '合成主题')).ok, true)
    assert.equal(store.getSession(first.id).name, '合成主题'); assert.equal(store.getSession(child.id).name, '合成主题-01')
    assert.equal((await store.setSessionRemarkAsync(owner, child.id, '', '独立备注')).ok, true)
    assert.equal(store.getSession(first.id).remark, ''); assert.equal(store.getSession(child.id).remark, '独立备注')
    assert.equal((await store.setSessionArchivedAsync(owner, child.id, false, true)).ok, true)
    assert.equal((await store.setSessionArchivedAsync(owner, child.id, true, false)).ok, true)
    assert.equal(store.getActiveSession(owner).id, first.id); assert.equal(store.getSession(first.id).input, 'PRIVATE SYNTHETIC DRAFT')
    assert.equal(store.getSession(first.id).mode, 'quick')
  } finally { store.dispose() }
})

test('会话管理：锁内核对 expected，等待期间本机新备注/归档/名称不被覆盖', async () => {
  const storage = stored(false), store = new SessionStore(storage, undefined, storage.locks)
  try {
    const first = store.createSession(owner)
    let release = storage.locks.block()
    const remark = store.setSessionRemarkAsync(owner, first.id, '', '旧请求')
    store.updateSession(first.id, { remark: '新备注' }); release()
    assert.equal((await remark).code, 'conflict'); assert.equal(store.getSession(first.id).remark, '新备注')
    release = storage.locks.block()
    const archive = store.setSessionArchivedAsync(owner, first.id, false, true)
    store.archiveSession(owner, first.id, true); release()
    assert.equal((await archive).code, 'conflict')
    release = storage.locks.block()
    const rename = store.renameTopicAsync(owner, first.topicId, first.topicName, '旧名称')
    store.renameSession(first.id, '新名称'); release()
    assert.equal((await rename).code, 'conflict'); assert.equal(store.getSession(first.id).topicName, '新名称')
  } finally { store.dispose() }
})

test('会话管理：跨窗口无通知的正文变化触发 CAS，名称读取最新后拒绝旧预期', async () => {
  const storage = stored(), first = new SessionStore(storage, undefined, storage.locks)
  const session = created(await create(first)), second = new SessionStore(storage, undefined, storage.locks)
  try {
    assert.equal((await second.setSessionRemarkAsync(owner, session.id, '', '另一窗口')).ok, true)
    assert.equal((await first.setSessionRemarkAsync(owner, session.id, '', '陈旧覆盖')).code, 'conflict')
    assert.equal((await first.setSessionArchivedAsync(owner, session.id, false, true)).code, 'conflict')
    assert.equal((await second.renameTopicAsync(owner, session.topicId, session.topicName, '远端新名称')).ok, true)
    assert.equal((await first.renameTopicAsync(owner, session.topicId, session.topicName, '陈旧名称')).code, 'conflict')
    assert.equal(JSON.parse(storage.getItem(historyKey(session.id))).session.remark, '另一窗口')
  } finally { first.dispose(); second.dispose() }
})

test('会话管理：关闭历史保留旧副本，持久主题只保留发号身份，重新开启保存当前运行期事实', async () => {
  const storage = stored(), store = new SessionStore(storage, undefined, storage.locks)
  try {
    const original = created(await create(store)); store.openSession(owner, original.id)
    const oldHistory = storage.getItem(historyKey(original.id)), oldName = storage.getItem(topicNameKey(original.topicId))
    assert.equal(await store.patchSettingsAsync({ rememberHistory: false }), true)
    const childResult = await create(store, { kind: 'parent_session', translationSessionId: original.id }), child = created(childResult)
    assert.equal(childResult.persistence, 'runtime_only'); assert.equal(storage.getItem(historyKey(child.id)), null)
    assert.equal(JSON.parse(storage.getItem(topicIdentityKey(original.topicId))).nextSequence, 2)
    assert.equal((await store.setSessionRemarkAsync(owner, original.id, '', '运行期备注')).persistence, 'runtime_only')
    assert.equal((await store.setSessionArchivedAsync(owner, original.id, false, true)).persistence, 'runtime_only')
    assert.equal((await store.renameTopicAsync(owner, original.topicId, original.topicName, '运行期名称')).persistence, 'runtime_only')
    assert.equal(storage.getItem(historyKey(original.id)), oldHistory); assert.equal(storage.getItem(topicNameKey(original.topicId)), oldName)
    assert.equal(await store.patchSettingsAsync({ rememberHistory: true }), true); await tick()
    assert.equal(JSON.parse(storage.getItem(historyKey(original.id))).session.remark, '运行期备注')
    assert.ok(JSON.parse(storage.getItem(historyKey(original.id))).session.archivedAt)
    assert.equal(JSON.parse(storage.getItem(historyKey(child.id))).session.topicName, '运行期名称')
  } finally { store.dispose() }
})

test('会话管理：orphan 主题可按 ID 重命名并后台续建，删除缺号不回填', async () => {
  const storage = stored(), store = new SessionStore(storage, undefined, storage.locks)
  try {
    const root = created(await create(store)), child = created(await create(store, { kind: 'parent_session', translationSessionId: root.id }))
    assert.equal(await store.deleteHistoryAsync([root.id, child.id]), true)
    const orphan = new SessionStore(storage, undefined, storage.locks)
    try {
      const renamed = await orphan.renameTopicAsync(owner, root.topicId, root.topicName, '孤立合成主题')
      assert.equal(renamed.ok, true); assert.deepEqual(renamed.sessions, [])
      const next = created(await create(orphan, { kind: 'existing_topic', topicId: root.topicId }))
      assert.equal(next.sequence, 2); assert.equal(next.name, '孤立合成主题-02'); assert.equal(next.input, '')
      assert.equal(orphan.getActiveSession(owner), undefined)
    } finally { orphan.dispose() }
  } finally { store.dispose() }
})

test('会话管理：写入失败不谎报 saved，内存变化可查且不伪造回滚', async () => {
  const storage = stored(), store = new SessionStore(storage, undefined, storage.locks)
  try {
    const original = created(await create(store)), old = storage.getItem(historyKey(original.id))
    storage.failKey = historyKey(original.id)
    const failed = await store.setSessionRemarkAsync(owner, original.id, '', '未保存备注')
    assert.equal(failed.ok, false); assert.equal(failed.code, 'storage_error'); assert.match(failed.message, /查询当前记录/)
    assert.equal(store.getSession(original.id).remark, '未保存备注'); assert.equal(storage.getItem(historyKey(original.id)), old)
    storage.failKey = 'history'
    const before = store.getAvailableSessions(owner).length, creation = await create(store)
    assert.equal(creation.ok, false); assert.equal(store.getAvailableSessions(owner).length, before + 1)
    assert.equal(store.getAvailableSessions(owner).at(-1).remark, '')
  } finally { store.dispose() }
})

test('会话管理：无锁仅纯运行期允许，不扩大为持久写入；跨 owner/删除屏障拒绝', async () => {
  const storage = stored(), lockedOut = new SessionStore(storage, undefined, null)
  try {
    assert.equal((await create(lockedOut)).ok, false); assert.equal([...storage.values.keys()].filter(key => key.includes(':topic:') || key.includes(':history:')).length, 0)
  } finally { lockedOut.dispose() }
  const runtime = new SessionStore(), session = runtime.createSession(owner)
  try {
    assert.equal((await runtime.createManagedSessionAsync('other-owner', { kind: 'parent_session', translationSessionId: session.id })).code, 'out_of_scope')
    assert.equal((await runtime.renameTopicAsync('other-owner', session.topicId, session.topicName, '非法主题')).code, 'out_of_scope')
    assert.equal((await runtime.setSessionRemarkAsync('other-owner', session.id, '', '非法备注')).code, 'out_of_scope')
    assert.equal(await runtime.deleteHistoryAsync([session.id]), true)
    assert.equal((await runtime.setSessionArchivedAsync(owner, session.id, false, true)).code, 'out_of_scope')
    assert.equal((await create(runtime, { kind: 'parent_session', translationSessionId: session.id })).code, 'out_of_scope')
  } finally { runtime.dispose() }
})

test('会话管理：相同预期及内容不改时间或重写会话，持久回执基于已有实际副本', async () => {
  const storage = stored(), store = new SessionStore(storage, undefined, storage.locks)
  try {
    const session = created(await create(store)), raw = storage.getItem(historyKey(session.id)), time = session.updatedAt
    assert.equal((await store.setSessionRemarkAsync(owner, session.id, '', '')).persistence, 'saved')
    assert.equal((await store.setSessionArchivedAsync(owner, session.id, false, false)).persistence, 'saved')
    assert.equal(storage.getItem(historyKey(session.id)), raw); assert.equal(store.getSession(session.id).updatedAt, time)
  } finally { store.dispose() }
})
