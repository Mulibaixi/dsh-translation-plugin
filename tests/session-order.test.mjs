import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionStore } from '../dist/client/session-store.js'
import { DEFAULT_SESSION_SETTINGS, SETTINGS_KEY, historyKey } from '../dist/client/sessions.js'
import { SESSION_ORDER_PREFIX, sessionOrderKey, encodeSessionOrder, decodeSessionOrder, reconcileSessionOrder, moveSessionOrder } from '../dist/client/session-order.js'

class Storage {
  values = new Map()
  failSet = false
  tail = Promise.resolve()
  locks = { request: (_name, action) => { const result = this.tail.then(action); this.tail = result.catch(() => {}); return result } }
  get length() { return this.values.size }
  key(i) { return [...this.values.keys()][i] ?? null }
  getItem(key) { return this.values.get(key) ?? null }
  setItem(key, value) { if (this.failSet) throw new Error('synthetic quota'); this.values.set(key, value) }
  removeItem(key) { this.values.delete(key) }
}
const create = (storage, listen) => new SessionStore(storage, listen, storage.locks)
const ids = sessions => sessions.map(session => session.id)

test('排序偏好仅解析ID；旧偏好过滤不存在项，新会话追加', () => {
  assert.deepEqual(decodeSessionOrder(encodeSessionOrder(['c', 'a'])), ['c', 'a'])
  for (const raw of ['{}', '{', JSON.stringify({ schemaVersion: 1, ids: ['a', 'a'] }), JSON.stringify({ schemaVersion: 1, ids: [1] }), JSON.stringify({ schemaVersion: 1, ids: ['a'], name: 'extra' })]) assert.equal(decodeSessionOrder(raw), undefined)
  assert.deepEqual(reconcileSessionOrder(['missing', 'c', 'a'], ['a', 'b', 'c', 'd']), ['c', 'a', 'b', 'd'])
  assert.deepEqual(moveSessionOrder(['a', 'b', 'c'], 'c', 'a', false), ['c', 'a', 'b'])
  assert.deepEqual(moveSessionOrder(['a', 'b', 'c'], 'a', 'c', true), ['b', 'c', 'a'])
})

test('历史关闭时排序只保存owner范围ID，不改变编号、内容、选择或业务顺序', async () => {
  const storage = new Storage(), store = create(storage)
  const a = await store.createSessionAsync('owner-a'), b = await store.createSessionAsync('owner-a', a.id), c = await store.createSessionAsync('owner-a'), other = await store.createSessionAsync('owner-b')
  store.updateSession(a.id, { input: '不能写入排序偏好的正文', remark: '不能写入排序偏好的备注' })
  const before = JSON.stringify(store.getAvailableSessions('owner-a')), active = store.getActiveSession('owner-a').id
  assert.equal(store.moveSessionInDisplay('owner-a', c.id, a.id), true)
  assert.deepEqual(ids(store.getDisplaySessions('owner-a')), [c.id, a.id, b.id])
  assert.equal(JSON.stringify(store.getAvailableSessions('owner-a')), before)
  assert.equal(store.getActiveSession('owner-a').id, active)
  assert.equal(storage.getItem(historyKey(a.id)), null)
  const raw = storage.getItem(sessionOrderKey('owner-a'))
  assert.deepEqual(JSON.parse(raw), { schemaVersion: 1, ids: [c.id, a.id, b.id] })
  assert.ok(!raw.includes('不能写入')); assert.ok([...storage.values.keys()].every(key => key.startsWith(SESSION_ORDER_PREFIX)))
  assert.equal(store.moveSessionInDisplay('owner-a', c.id, other.id), false)
  assert.deepEqual(ids(store.getDisplaySessions('owner-b')), [other.id])
  const d = await store.createSessionAsync('owner-a')
  assert.deepEqual(ids(store.getDisplaySessions('owner-a')), [c.id, a.id, b.id, d.id])
  store.dispose()
  const restarted = create(storage)
  assert.deepEqual(restarted.getDisplaySessions('owner-a'), [])
  const fresh = await restarted.createSessionAsync('owner-a')
  assert.deepEqual(ids(restarted.getDisplaySessions('owner-a')), [fresh.id])
  restarted.dispose()
})

test('旧历史默认保持创建顺序；独立排序在关闭历史后保存并跨重启恢复，归档恢复保留位置', async () => {
  const storage = new Storage(); storage.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SESSION_SETTINGS, rememberHistory: true }))
  let store = create(storage)
  const a = await store.createSessionAsync('owner'), b = await store.createSessionAsync('owner', a.id), c = await store.createSessionAsync('owner', b.id)
  const original = ids(store.getAvailableSessions('owner'))
  assert.deepEqual(ids(store.getDisplaySessions('owner')), original)
  await store.patchSettingsAsync({ rememberHistory: false })
  assert.equal(store.moveSessionInDisplay('owner', c.id, a.id), true)
  store.archiveSession('owner', a.id)
  assert.equal(store.moveSessionInDisplay('owner', a.id, b.id), false)
  store.archiveSession('owner', a.id, false)
  assert.deepEqual(ids(store.getDisplaySessions('owner')), [c.id, a.id, b.id])
  store.dispose(); store = create(storage)
  assert.equal(store.getSettings().rememberHistory, false)
  assert.deepEqual(ids(store.getDisplaySessions('owner')), [c.id, a.id, b.id])
  assert.deepEqual(ids(store.getAvailableSessions('owner')), original)
  assert.deepEqual(store.getAvailableSessions('owner').map(session => session.sequence), [0, 1, 2])
  assert.equal(await store.deleteHistoryAsync([a.id]), true)
  assert.deepEqual(decodeSessionOrder(storage.getItem(sessionOrderKey('owner'))), [c.id, b.id])
  store.dispose(); store = create(storage)
  assert.deepEqual(ids(store.getDisplaySessions('owner')), [c.id, b.id]); store.dispose()
})

test('排序storage通知只同步显示偏好，不覆盖当前草稿；损坏偏好保留副本', async () => {
  const storage = new Storage(); storage.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SESSION_SETTINGS, rememberHistory: true }))
  const source = create(storage), a = await source.createSessionAsync('owner'), b = await source.createSessionAsync('owner')
  let onChange
  const receiving = create(storage, fn => { onChange = fn; return () => {} })
  await source.patchSettingsAsync({ rememberHistory: false }); onChange(SETTINGS_KEY)
  receiving.updateSession(a.id, { input: '未保存的新草稿' })
  receiving.getDisplaySessions('owner')
  source.moveSessionInDisplay('owner', b.id, a.id); onChange(sessionOrderKey('owner'))
  assert.deepEqual(ids(receiving.getDisplaySessions('owner')), [b.id, a.id])
  assert.equal(receiving.getSession(a.id).input, '未保存的新草稿')
  storage.setItem(sessionOrderKey('owner'), '{'); onChange(sessionOrderKey('owner'))
  assert.deepEqual(ids(receiving.getDisplaySessions('owner')), [a.id, b.id])
  assert.match(receiving.getNotice(), /排序偏好读取失败/); assert.equal(storage.getItem(sessionOrderKey('owner')), '{')
  source.dispose(); receiving.dispose()
})

test('排序写入失败保留本次顺序并提示，删除仍移除会话并报告偏好清理失败', async () => {
  const storage = new Storage(), store = create(storage)
  const a = await store.createSessionAsync('owner'), b = await store.createSessionAsync('owner')
  storage.failSet = true
  assert.equal(store.moveSessionInDisplay('owner', b.id, a.id), false)
  assert.deepEqual(ids(store.getDisplaySessions('owner')), [b.id, a.id]); assert.match(store.getNotice(), /排序未保存/)
  assert.equal(await store.deleteHistoryAsync([a.id]), true)
  assert.equal(store.getSession(a.id), undefined); assert.deepEqual(ids(store.getDisplaySessions('owner')), [b.id]); assert.match(store.getNotice(), /排序偏好清理未保存/)
  store.dispose()
})
